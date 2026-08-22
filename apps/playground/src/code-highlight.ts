import { highlightTree, tagHighlighter, tags as t } from '@lezer/highlight';
import type { Language } from '@codemirror/language';
import { StreamLanguage } from '@codemirror/language';
import {
  javascriptLanguage,
  jsxLanguage,
  tsxLanguage,
  typescriptLanguage,
} from '@codemirror/lang-javascript';
import { cssLanguage } from '@codemirror/lang-css';
import { htmlLanguage } from '@codemirror/lang-html';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { shell } from '@codemirror/legacy-modes/mode/shell';

/**
 * Preview-only syntax highlighting for rendered code blocks (GitHub issue
 * #5). This is playground scope ONLY: `@markii/react` never re-highlights a
 * code fence (see `ScriptMarker`'s doc comment, "never reformatted or
 * re-highlighted") and this module does not touch it.
 *
 * Two kinds of grammar feed `LANGUAGES` below, both direct dependencies of
 * this app (see `package.json`):
 *
 * - Lezer grammars (`@codemirror/lang-javascript`, `lang-css`, `lang-html`,
 *   `lang-markdown`), used via their exported `Language` objects directly.
 * - `@codemirror/legacy-modes`' CodeMirror-5-style stream parsers, adapted
 *   to a Lezer-shaped `Language` via `StreamLanguage.define` (still driven
 *   through the same `highlightTree` call below — the caller doesn't need
 *   to know which kind a given entry is). This is how Lua and shell are
 *   covered: neither has a real Lezer grammar anywhere, but `legacy-modes`
 *   ships hand-written stream parsers for both.
 *
 * `@codemirror/legacy-modes` does NOT have a JSON mode (checked its
 * `mode/*.d.ts` listing directly), and no package in this app's dependency
 * tree exports one either, so JSON fences stay plain — the same graceful,
 * silent degradation every other unlisted language (Python, Ruby, Go, …)
 * gets. `isHighlightableLanguage`/`highlightCodeHtml` never throw regardless
 * of what `lang` is.
 */
const LANGUAGES: Record<string, Language> = {
  js: javascriptLanguage,
  javascript: javascriptLanguage,
  mjs: javascriptLanguage,
  cjs: javascriptLanguage,
  jsx: jsxLanguage,
  ts: typescriptLanguage,
  typescript: typescriptLanguage,
  tsx: tsxLanguage,
  css: cssLanguage,
  html: htmlLanguage,
  htm: htmlLanguage,
  xml: htmlLanguage,
  md: markdownLanguage,
  markdown: markdownLanguage,
  lua: StreamLanguage.define(lua),
  sh: StreamLanguage.define(shell),
  shell: StreamLanguage.define(shell),
  bash: StreamLanguage.define(shell),
};

/** Maps Lezer highlight tags onto class names styled in `styles.css`. */
const highlighter = tagHighlighter([
  { tag: t.comment, class: 'tok-comment' },
  { tag: [t.string, t.special(t.string)], class: 'tok-string' },
  { tag: [t.number, t.bool, t.null], class: 'tok-number' },
  {
    tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword],
    class: 'tok-keyword',
  },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName)],
    class: 'tok-function',
  },
  { tag: t.propertyName, class: 'tok-property' },
  { tag: t.attributeName, class: 'tok-attribute' },
  {
    tag: [t.definition(t.variableName), t.definitionOperator],
    class: 'tok-definition',
  },
  { tag: t.variableName, class: 'tok-variable' },
  { tag: [t.typeName, t.className], class: 'tok-type' },
  { tag: t.tagName, class: 'tok-tag' },
  { tag: [t.heading, t.strong], class: 'tok-strong' },
  { tag: t.emphasis, class: 'tok-emphasis' },
  { tag: [t.link, t.url], class: 'tok-link' },
  { tag: [t.punctuation, t.bracket], class: 'tok-punctuation' },
  { tag: t.operator, class: 'tok-operator' },
  { tag: t.regexp, class: 'tok-regexp' },
  { tag: t.meta, class: 'tok-meta' },
  { tag: t.invalid, class: 'tok-invalid' },
]);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function normalizeLang(lang: string): string {
  return lang.trim().toLowerCase();
}

/** Whether `lang` (a fence's language tag, case/space insensitive) has a registered grammar. */
export function isHighlightableLanguage(lang: string): boolean {
  return normalizeLang(lang) in LANGUAGES;
}

/**
 * Highlights `code` as `lang` and returns HTML with recognized tokens
 * wrapped in `<span class="tok-*">` (text is HTML-escaped throughout).
 * Returns `null` — never throws — when `lang` has no registered grammar or
 * parsing fails; callers keep the existing plain rendering in that case.
 */
export function highlightCodeHtml(code: string, lang: string): string | null {
  const language = LANGUAGES[normalizeLang(lang)];
  if (!language) return null;

  try {
    const tree = language.parser.parse(code);
    let out = '';
    let pos = 0;
    highlightTree(tree, highlighter, (from, to, classes) => {
      if (from > pos) out += escapeHtml(code.slice(pos, from));
      out += `<span class="${classes}">${escapeHtml(code.slice(from, to))}</span>`;
      pos = to;
    });
    if (pos < code.length) out += escapeHtml(code.slice(pos));
    return out;
  } catch {
    return null;
  }
}

function applyHighlight(codeEl: Element, lang: string): void {
  if (!lang) return;
  const html = highlightCodeHtml(codeEl.textContent ?? '', lang);
  if (html === null) return;
  codeEl.innerHTML = html;
  codeEl.classList.add('mk-hl');
}

/** Reads the `language-xyz` class `mdast-util-to-hast`'s default `code` handler adds, or `''`. */
function classLanguage(codeEl: Element): string {
  for (const cls of codeEl.classList) {
    if (cls.startsWith('language-')) return cls.slice('language-'.length);
  }
  return '';
}

/**
 * Post-processes a rendered `.doc` subtree in place, highlighting every code
 * block it can. Two shapes exist in `@markii/react`'s output:
 *
 * - An ordinary fenced code block: `<pre><code class="language-x">…`.
 * - A folded script marker (`ScriptMarker`): `<details class="mk-script">`
 *   whose `<summary>` reads `⚙ name · lang` and whose body is a plain
 *   `<pre class="mk-script__code"><code>…` with NO language class (by
 *   design — `@markii/react` never adds one there). The language is
 *   recovered from the summary text instead.
 *
 * Call this from a `useLayoutEffect` keyed so it only ever runs against a
 * freshly mounted subtree (see `App.tsx`) — mutating `innerHTML` here is
 * safe only because the caller guarantees React will not try to reconcile
 * against these nodes afterward.
 */
export function highlightPreviewCodeBlocks(root: ParentNode): void {
  root.querySelectorAll('pre > code[class*="language-"]').forEach((codeEl) => {
    applyHighlight(codeEl, classLanguage(codeEl));
  });

  root.querySelectorAll('.mk-script').forEach((details) => {
    const codeEl = details.querySelector('pre.mk-script__code > code');
    if (!codeEl) return;
    const summary =
      details.querySelector('.mk-script__summary')?.textContent ?? '';
    const sep = summary.lastIndexOf(' · ');
    const lang = sep === -1 ? '' : summary.slice(sep + 3).trim();
    applyHighlight(codeEl, lang);
  });
}
