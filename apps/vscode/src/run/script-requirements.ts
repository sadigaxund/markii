/**
 * Pure, vscode-free analysis of what a manual run of a document WILL need
 * (slice 1 of the v2 Run arc, GitHub issue #1's locked design comment):
 * the runnable script blocks, and the set of hostnames its scripts
 * statically reach for via `net.fetch_json`/`net.post`/`net.patch`. Slice 2
 * uses this to drive the grant/prompt flow ("This note's scripts can send
 * data to <host>. Allow?") — this module does no prompting, no storage,
 * and no execution; it only reads.
 *
 * Host extraction is deliberately BEST-EFFORT: it is a plain textual scan
 * of each inline script's Lua source, not a Lua parser. A call whose URL
 * argument is a single, unconcatenated string literal
 * (`net.fetch_json("https://api.example.com/x")`) is picked up exactly;
 * anything else — a variable, a `..` concatenation, an expression, a
 * `src=` long-script reference whose body isn't even in this document —
 * cannot be resolved statically and is folded into `hasUnknownHosts`
 * instead of being silently missed. Fail toward "prompt more broadly",
 * never toward "let an unrecognized host slip through unprompted": a false
 * positive here just means one extra grant prompt; a false negative would
 * mean a host reaching the network with no prompt at all.
 */
import type { Root } from 'mdast';
import { extractScripts, parse, type ScriptBlock } from '@markii/core';
import type { GrantClosureScript } from '@markii/runtime';

/** One document's static run requirements. */
export interface RunRequirements {
  /** Every script block found, in document order — `@markii/core`'s `extractScripts` result, unmodified. */
  scripts: ScriptBlock[];
  /**
   * Hostnames this run's scripts are statically known to reach via
   * `net.*`, deduplicated, in first-seen (document) order. Does NOT
   * include hosts that could only be discovered by actually running the
   * script (see `hasUnknownHosts`).
   */
  hosts: string[];
  /**
   * `true` when at least one `net.fetch_json`/`net.post`/`net.patch` call
   * site's URL argument could not be resolved to a literal (a
   * concatenation, a variable, any non-literal expression), OR when any
   * script block is a `src=` reference (its actual Lua source lives in a
   * bundle file this function never reads, so its `net.*` usage — if any —
   * is entirely unknown). The caller should read this as "prompt for
   * network access more broadly" rather than trusting `hosts` alone to be
   * the complete set.
   */
  hasUnknownHosts: boolean;
  /**
   * `scripts` reshaped into `@markii/runtime`'s `GrantClosureScript` — the
   * exact per-script record `computeGrantKey`'s `GrantClosure.scripts`
   * field expects (`{ name, lang, src, code }`). `computeGrantKey` itself
   * sorts records by their own encoded bytes before hashing, so array
   * order here does not affect the resulting key — this is already in
   * document order (from `extractScripts`), which is what makes repeated
   * extraction over the same text byte-identical, satisfying the "stable
   * order" requirement without this module needing to reimplement any of
   * `computeGrantKey`'s own sorting.
   */
  grantScripts: GrantClosureScript[];
}

/** The three host-reaching capability calls this scan looks for (docs/scripting.md's `net` table). */
const NET_CALL_NAMES = ['fetch_json', 'post', 'patch'] as const;

const CALL_SITE_PATTERN = new RegExp(
  `\\bnet\\.(${NET_CALL_NAMES.join('|')})\\s*\\(`,
  'g',
);

/**
 * Given `source` and the index of the character immediately after a call's
 * opening `(` (already matched by `CALL_SITE_PATTERN`), returns the raw
 * text of that call's FIRST argument — up to (not including) the first
 * top-level `,` or the call's closing `)`, tracking nested
 * `(`/`)`/`[`/`]`/`{`/`}` depth and quoted strings so a comma or paren
 * INSIDE a nested expression or a quoted string never ends the scan early.
 * Returns `undefined` if the call is unterminated (no matching close found
 * before the source ends) — a malformed/incomplete script, treated the
 * same as any other non-literal argument by the caller.
 */
function extractFirstArgument(
  source: string,
  argStart: number,
): string | undefined {
  let depth = 0;
  let quote: '"' | "'" | undefined;
  for (let i = argStart; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') {
        i++; // skip the escaped character, whatever it is
        continue;
      }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0 && ch === ')') {
        return source.slice(argStart, i);
      }
      depth--;
      continue;
    }
    if (ch === ',' && depth === 0) {
      return source.slice(argStart, i);
    }
  }
  return undefined;
}

/**
 * Whether `text` is EXACTLY one quoted string literal with nothing else
 * around it (only leading/trailing whitespace) — the one shape this scan
 * trusts as "a literal URL", per this module's top doc comment. Anything
 * else (a `..` concatenation, a bare identifier, a function call, a second
 * literal joined to the first) fails this and is reported as unknown
 * rather than guessed at.
 */
const SOLE_STRING_LITERAL = /^\s*(["'])((?:\\.|(?!\1)[^\\])*)\1\s*$/;

function literalStringValue(argument: string): string | undefined {
  const match = SOLE_STRING_LITERAL.exec(argument);
  if (!match) return undefined;
  // Unescape only the two escapes Lua string literals actually need for a
  // URL to round-trip (`\\` and the literal's own quote character) — this
  // is a best-effort textual scan, not a full Lua string-literal decoder;
  // any other backslash escape is left as-is (harmless: it would simply
  // fail `new URL(...)` below, falling through to "not a literal we can
  // use" as intended for `hasUnknownHosts`, rather than corrupting a URL
  // that didn't have JavaScript-different escapes to begin with).
  return (match[2] ?? '').replace(/\\(.)/g, '$1');
}

/** Bare, lowercased hostname from a URL string, or `undefined` if it doesn't parse as an absolute URL. */
function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Scans one script block's Lua source for `net.*` call sites and folds
 * their findings into `hosts`/`markUnknown` — see this module's top doc
 * comment for the literal-only matching rule.
 */
function scanForHosts(
  code: string,
  hosts: Set<string>,
  markUnknown: () => void,
): void {
  CALL_SITE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CALL_SITE_PATTERN.exec(code)) !== null) {
    const argStart = match.index + match[0].length;
    const argument = extractFirstArgument(code, argStart);
    if (argument === undefined) {
      markUnknown();
      continue;
    }
    const literal = literalStringValue(argument);
    if (literal === undefined) {
      // Present but not a sole literal -- a concatenation, a variable, a
      // nested call, ... exactly the "cannot resolve statically" case.
      markUnknown();
      continue;
    }
    const host = hostnameOf(literal);
    if (host === undefined) {
      // Syntactically a literal, but not a URL `new URL()` can parse
      // (e.g. a bare path or template-ish string) -- still unknown to us.
      markUnknown();
      continue;
    }
    hosts.add(host);
  }
}

function toGrantClosureScript(block: ScriptBlock): GrantClosureScript {
  const script: GrantClosureScript = {
    name: block.name,
    lang: block.lang,
    code: block.code,
  };
  if (block.src !== undefined) script.src = block.src;
  return script;
}

/**
 * Computes `RunRequirements` for `text` — parses it with `@markii/core`'s
 * `parse`, pulls its script blocks with `extractScripts`, and scans each
 * INLINE block's own source for statically-resolvable `net.*` hosts. Pure:
 * no I/O, no `vscode`, safe to call on every keystroke if a future slice
 * wants a live preview of what a run would ask for.
 */
export function extractRunRequirements(text: string): RunRequirements {
  const tree: Root = parse(text);
  const scripts = extractScripts(tree);

  const hosts = new Set<string>();
  let hasUnknownHosts = false;
  const markUnknown = (): void => {
    hasUnknownHosts = true;
  };

  for (const block of scripts) {
    if (block.src !== undefined) {
      // The referenced file's source isn't in `text` at all -- its net
      // usage, if any, is entirely unknown to this scan. See this
      // module's top doc comment.
      markUnknown();
      continue;
    }
    scanForHosts(block.code, hosts, markUnknown);
  }

  return {
    scripts,
    hosts: [...hosts],
    hasUnknownHosts,
    grantScripts: scripts.map(toGrantClosureScript),
  };
}
