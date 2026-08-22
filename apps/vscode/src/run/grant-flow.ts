/**
 * Slice 2's grant/prompt flow (docs: GitHub issue #1's locked design
 * comment) — vscode-free by design, same split as `./run-host.ts` and
 * `./script-requirements.ts`: this module decides WHAT to prompt and WHAT
 * to persist, but never calls `vscode.window.showInformationMessage` or
 * `context.workspaceState` directly. The extension-host adapter
 * (`extension.ts`/`preview-panel.ts` — the only files allowed to import
 * `vscode`) supplies the actual prompt UI and Memento, both behind the thin
 * interfaces below, so this file stays unit-testable with plain fakes.
 *
 * ## Keying
 *
 * `computeGrantKey` (`@markii/runtime`) hashes the note's executable
 * closure — for a bare `.mk.md` note (this arc's whole scope; bundles are
 * out of scope), that closure is just its own script blocks
 * (`RunRequirements.grantScripts`), with empty `bundleModules`/
 * `vaultModules`/`packs`. Any edit to any script's code changes the hash,
 * which is what makes "any code change re-prompts" fall out of the keying
 * scheme for free rather than needing its own diffing logic here.
 *
 * ## Storage
 *
 * One `{key, allowedHosts}` record per document, keyed by the document's
 * URI string, all held under one Memento key (`GRANTS_STORAGE_KEY`) as a
 * plain map. A stored record whose `key` no longer matches the freshly
 * computed one is a MISS — this module never trusts a stale record's
 * `allowedHosts`, even partially; the whole grant re-derives from scratch.
 *
 * ## The two prompt shapes
 *
 * - One prompt per statically-known host (`promptHost`), worded exactly
 *   "This note's scripts can send data to <host>. Allow?" — see
 *   `hostPromptMessage`.
 * - Exactly one extra prompt (`promptUnknownHosts`,
 *   `UNKNOWN_HOSTS_PROMPT_MESSAGE`) when the closure could reach hosts that
 *   cannot be listed in advance (`RunRequirements.hasUnknownHosts`, or a
 *   host string this module refuses to render — see `isSafeHostForPrompt`).
 *   Accepting it does NOT add anything to `allowedHosts` — there is no host
 *   name to grant — it is a consent gate: declining it clears every
 *   already-collected per-host answer too, since a script that can reach
 *   addresses it never named cannot be trusted to only use the hosts it DID
 *   name. A dynamically-built address a script hits at RUN TIME, whether or
 *   not this prompt was accepted, is never added to `allowedHosts` here (it
 *   is not known in advance); it fails at execution with the ordinary
 *   `'capability-denied'` kind, same as any other ungranted host.
 */
import {
  computeGrantKey,
  type GrantClosure,
  type GrantClosureScript,
} from '@markii/runtime';

/** The subset of `RunRequirements` (`./script-requirements.ts`) this flow needs — kept structural rather than importing the whole interface, so a fake in tests doesn't need to fabricate `scripts`. */
export interface GrantFlowRequirements {
  readonly hosts: readonly string[];
  readonly hasUnknownHosts: boolean;
  readonly grantScripts: readonly GrantClosureScript[];
}

/**
 * The `Thenable` shape `vscode.Memento.update` actually returns — restated
 * here (rather than importing `vscode`, which this file must never do) so
 * a real `vscode.Memento` is assignable to `GrantMemento` with no adapter
 * class, and a plain `Promise`-returning fake satisfies it in tests too.
 */
export interface Thenable<T> {
  then<TResult1 = T, TResult2 = never>(
    onFulfilled?:
      ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onRejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | undefined
      | null,
  ): PromiseLike<TResult1 | TResult2>;
}

/** The exact shape of `vscode.Memento` this module uses — `context.workspaceState` satisfies this directly. */
export interface GrantMemento {
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

/** Prompts once for `host`, resolving `true` for Allow, `false` for Don't allow (or the prompt being dismissed). */
export type PromptHost = (host: string) => Promise<boolean>;

/** Prompts once for the "this note builds a network address dynamically" consent gate. */
export type PromptUnknownHosts = () => Promise<boolean>;

export interface GrantFlowOptions {
  /** Stable identity for the note this run belongs to — `vscode.Uri.toString()` of the document, in the real adapter. */
  documentKey: string;
  requirements: GrantFlowRequirements;
  memento: GrantMemento;
  promptHost: PromptHost;
  promptUnknownHosts: PromptUnknownHosts;
}

export interface GrantFlowResult {
  /** The hostnames this run's `net.*` calls may reach — exactly what `spawnRun`'s `netAllowlist` (`./run-host.ts`) expects. */
  allowedHosts: string[];
}

/** Exact prompt wording — normative per the locked design comment. Exported so a test (and the adapter that renders it) both anchor on the same string. */
export function hostPromptMessage(host: string): string {
  return `This note's scripts can send data to ${host}. Allow?`;
}

/** Exact wording of the one extra "hosts can't be listed in advance" prompt. */
export const UNKNOWN_HOSTS_PROMPT_MESSAGE =
  "This note builds a network address dynamically, so its hosts can't be listed in advance. Allow network access?";

/** Button labels every prompt in this flow uses — both a plain "Allow" and a "Don't allow" refusal are always offered, never a bare dismiss-only message. */
export const ALLOW_LABEL = 'Allow';
export const DONT_ALLOW_LABEL = "Don't allow";

const GRANTS_STORAGE_KEY = 'markii.netGrants';

interface StoredGrant {
  readonly key: string;
  readonly allowedHosts: readonly string[];
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Never trusts a Memento's stored shape — a corrupt/foreign/hand-edited value degrades to "no stored grant" rather than throwing or partially applying. */
function isStoredGrant(value: unknown): value is StoredGrant {
  if (!isPlainObject(value)) return false;
  if (!hasOwn(value, 'key') || typeof value.key !== 'string') return false;
  if (
    !hasOwn(value, 'allowedHosts') ||
    !Array.isArray(value.allowedHosts) ||
    !value.allowedHosts.every((host) => typeof host === 'string')
  ) {
    return false;
  }
  return true;
}

function readAllGrants(memento: GrantMemento): Record<string, unknown> {
  const raw = memento.get<unknown>(GRANTS_STORAGE_KEY, {});
  return isPlainObject(raw) ? raw : {};
}

function readGrant(
  memento: GrantMemento,
  documentKey: string,
): StoredGrant | undefined {
  const all = readAllGrants(memento);
  if (!hasOwn(all, documentKey)) return undefined;
  const candidate = all[documentKey];
  return isStoredGrant(candidate) ? candidate : undefined;
}

async function writeGrant(
  memento: GrantMemento,
  documentKey: string,
  grant: StoredGrant,
): Promise<void> {
  const all = readAllGrants(memento);
  const next = { ...all, [documentKey]: grant };
  await memento.update(GRANTS_STORAGE_KEY, next);
}

/**
 * A conservative hostname-shape check for what this module is willing to
 * interpolate into a prompt string. `extractRunRequirements`
 * (`./script-requirements.ts`) already derives every host in
 * `RunRequirements.hosts` from `new URL(literal).hostname` — which can
 * never itself contain whitespace or control characters — but this is a
 * second, independent gate at the point of DISPLAY: defense in depth
 * against a future host-extraction bug (or a deliberately different caller
 * of this module) ever interpolating raw, unvalidated note text into a
 * modal dialog. Accepts ordinary DNS names, bracketed IPv6 literals, and
 * plain IPv4 literals; rejects everything else, including any control or
 * whitespace character.
 */
const SAFE_HOSTNAME_PATTERN =
  /^(?:[a-z0-9]([a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$|^\[[0-9a-f:]+\]$|^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/i;

export function isSafeHostForPrompt(host: string): boolean {
  // SAFE_HOSTNAME_PATTERN is a full, anchored (^...$) match against a
  // closed character set, so no whitespace or control character can ever
  // pass it -- no separate check is needed.
  return (
    typeof host === 'string' &&
    host.length > 0 &&
    host.length <= 253 &&
    SAFE_HOSTNAME_PATTERN.test(host)
  );
}

/**
 * Splits `hosts` into the ones safe to render in a per-host prompt, and
 * whether the "can't be listed in advance" prompt is needed — either
 * because the static scan already said so (`hasUnknownHosts`), or because
 * at least one extracted host failed `isSafeHostForPrompt` and must never
 * be shown verbatim. Failing toward the broader prompt (never toward
 * silently dropping a host with no prompt at all) mirrors
 * `extractRunRequirements`'s own philosophy.
 */
function partitionHosts(
  hosts: readonly string[],
  hasUnknownHosts: boolean,
): { safeHosts: string[]; needsUnknownPrompt: boolean } {
  const safeHosts: string[] = [];
  let needsUnknownPrompt = hasUnknownHosts;
  for (const host of hosts) {
    if (isSafeHostForPrompt(host)) {
      safeHosts.push(host);
    } else {
      needsUnknownPrompt = true;
    }
  }
  return { safeHosts, needsUnknownPrompt };
}

function closureFrom(requirements: GrantFlowRequirements): GrantClosure {
  return {
    scripts: [...requirements.grantScripts],
    bundleModules: {},
    vaultModules: {},
    packs: [],
  };
}

/**
 * Runs the whole grant flow for one Run press: computes the closure's grant
 * key, reuses a matching stored grant with NO prompting at all, or (on a
 * miss — first run or any code change) prompts fresh for every host and the
 * unknown-hosts gate, persists the result, and returns the allowlist
 * `spawnRun` should use.
 */
export async function runGrantFlow(
  options: GrantFlowOptions,
): Promise<GrantFlowResult> {
  const { documentKey, requirements, memento, promptHost, promptUnknownHosts } =
    options;

  const key = await computeGrantKey(closureFrom(requirements));
  const stored = readGrant(memento, documentKey);
  if (stored && stored.key === key) {
    return { allowedHosts: [...stored.allowedHosts] };
  }

  const { safeHosts, needsUnknownPrompt } = partitionHosts(
    requirements.hosts,
    requirements.hasUnknownHosts,
  );

  const allowedHosts: string[] = [];
  for (const host of safeHosts) {
    // Each prompt is modal; they must appear one at a time, never all at
    // once, so this loop is deliberately sequential rather than
    // `Promise.all`-ed.
    const allowed = await promptHost(host);
    if (allowed) allowedHosts.push(host);
  }

  let finalAllowedHosts = allowedHosts;
  if (needsUnknownPrompt) {
    const allowed = await promptUnknownHosts();
    if (!allowed) {
      // Declining the "can't be listed in advance" gate withdraws every
      // per-host answer already collected too — see this module's top doc
      // comment.
      finalAllowedHosts = [];
    }
  }

  await writeGrant(memento, documentKey, {
    key,
    allowedHosts: finalAllowedHosts,
  });

  return { allowedHosts: finalAllowedHosts };
}
