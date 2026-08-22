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
 * A record is only ever WRITTEN when `allowedHosts` ends up non-empty — a
 * full decline is never persisted, so it simply re-prompts next time (see
 * `runGrantFlow`'s own comment on this, C-3) — and `clearGrantForDocument`
 * removes a document's record outright, for the `markii.resetScriptGrants`
 * command.
 *
 * ## The prompt shapes
 *
 * - One prompt per statically-known host (`promptHost`), worded exactly
 *   "This note's scripts can send data to <host>. Allow?" — see
 *   `hostPromptMessage`. Used only while the distinct safe host count is at
 *   or under `MAX_HOST_PROMPTS`; above that, `promptManyHosts` (below) takes
 *   over instead so a note can never turn one Run press into a wall of
 *   modals (the PROMPT-STORM fix — see `MAX_HOST_PROMPTS`'s doc comment).
 * - `promptManyHosts`, exactly once, in place of the whole per-host loop
 *   when there are more than `MAX_HOST_PROMPTS` distinct safe hosts: one
 *   all-or-nothing gate ("This note requests network access to many hosts
 *   (N). Allow all or deny all?", `manyHostsPromptMessage`) rather than N
 *   separate dialogs.
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

/** Prompts once for the consolidated "many hosts" gate (PROMPT-STORM fix) — resolves `true` for Allow all, `false` for Deny all. */
export type PromptManyHosts = (hostCount: number) => Promise<boolean>;

export interface GrantFlowOptions {
  /** Stable identity for the note this run belongs to — `vscode.Uri.toString()` of the document, in the real adapter. */
  documentKey: string;
  requirements: GrantFlowRequirements;
  memento: GrantMemento;
  promptHost: PromptHost;
  promptUnknownHosts: PromptUnknownHosts;
  /** Consolidated gate used instead of the per-host loop once the distinct static host count exceeds `MAX_HOST_PROMPTS` — see that constant's doc comment. */
  promptManyHosts: PromptManyHosts;
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

/**
 * PROMPT-STORM fix (report section 8, item 6, PENTEST-REPORT-2026-08-23.md):
 * `runGrantFlow`'s per-host loop below is sequential and modal, one dialog
 * per statically-extracted host. A hostile note with hundreds of literal
 * `net.fetch_json("https://hostN/")` calls would otherwise re-open hundreds
 * of modals on EVERY `markii.runScripts` press — and because a FULL decline
 * is deliberately never persisted (C-3, so one mis-click can't permanently
 * lock out network access), nothing about answering them once makes them
 * stop recurring on the next Run press either. That makes the per-host loop
 * itself a denial-of-service surface against the user's own attention, not
 * just an annoyance.
 *
 * The guard: cap how many per-host prompts one run will ever show. When the
 * distinct SAFE static host count is at or under this cap, the ordinary
 * per-host flow runs exactly as before (this is overwhelmingly the common
 * case — most notes touch a small, fixed set of APIs). Above the cap, the
 * per-host loop is skipped entirely in favor of ONE consolidated prompt
 * (`promptManyHosts`) that grants either every one of those hosts or none of
 * them — still a single, honest, all-or-nothing consent decision, just sized
 * to the actual scale of what's being asked, rather than a wall of modals a
 * user would rationally start rubber-stamping. 10 is comfortably above what
 * a legitimate dashboard-style note (docs/scripting.md's callout on
 * dashboards being a first-class use case) is expected to reach while still
 * catching a hostile host list before it becomes hundreds of dialogs.
 */
export const MAX_HOST_PROMPTS = 10;

/** Exact wording of the consolidated "many hosts" gate — normative, mirroring `hostPromptMessage`/`UNKNOWN_HOSTS_PROMPT_MESSAGE`'s pattern of an exported, test-anchored string. */
export function manyHostsPromptMessage(hostCount: number): string {
  return `This note requests network access to many hosts (${hostCount}). Allow all or deny all?`;
}

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

/**
 * A `readGrant` result annotated with whether re-validation dropped
 * anything (N-6, PENTEST-REPORT-2026-08-23.md).
 */
interface ReadGrantResult {
  readonly grant: StoredGrant;
  /** `true` when at least one stored host failed today's `isSafeHostForPrompt` re-check and was dropped. */
  readonly droppedUnsafeHost: boolean;
}

/**
 * Reads the stored grant for `documentKey`, if any, and re-runs every one of
 * its `allowedHosts` through `isSafeHostForPrompt` before returning it (N-6):
 * a stored record's hosts were only ever validated at COLLECTION time,
 * possibly under an older/buggier version of this module, or (with direct
 * `workspaceState` write access) never validated at all. Trusting the shape
 * check alone and not re-deriving the safety property at read time would let
 * a planted or stale record become the effective allowlist verbatim. Any
 * host that fails re-validation is dropped from the returned grant, and
 * `droppedUnsafeHost` is set so `runGrantFlow` know it must not treat this as
 * a clean cache hit — see its own comment at the call site.
 */
function readGrant(
  memento: GrantMemento,
  documentKey: string,
): ReadGrantResult | undefined {
  const all = readAllGrants(memento);
  if (!hasOwn(all, documentKey)) return undefined;
  const candidate = all[documentKey];
  if (!isStoredGrant(candidate)) return undefined;

  const safeHosts = candidate.allowedHosts.filter(isSafeHostForPrompt);
  return {
    grant: { key: candidate.key, allowedHosts: safeHosts },
    droppedUnsafeHost: safeHosts.length !== candidate.allowedHosts.length,
  };
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
  const {
    documentKey,
    requirements,
    memento,
    promptHost,
    promptUnknownHosts,
    promptManyHosts,
  } = options;

  const key = await computeGrantKey(closureFrom(requirements));
  const stored = readGrant(memento, documentKey);
  // N-6: a matching key alone is not enough to reuse a stored grant with no
  // prompting -- only take the fast path when EVERY stored host still
  // passes today's safety re-check. If `readGrant` had to drop anything,
  // the record is not trusted at all here; fall through to the ordinary
  // prompt flow below, which re-derives from the note's CURRENT
  // requirements and, once answered, overwrites the untrusted record via
  // the normal `writeGrant` call at the end of this function.
  if (stored && stored.grant.key === key && !stored.droppedUnsafeHost) {
    return { allowedHosts: [...stored.grant.allowedHosts] };
  }

  const { safeHosts, needsUnknownPrompt } = partitionHosts(
    requirements.hosts,
    requirements.hasUnknownHosts,
  );

  let allowedHosts: string[];
  if (safeHosts.length > MAX_HOST_PROMPTS) {
    // PROMPT-STORM guard: too many distinct hosts for the per-host loop --
    // fold the whole set into one consolidated all-or-nothing gate instead
    // of opening `safeHosts.length` modals in a row. See `MAX_HOST_PROMPTS`'s
    // doc comment.
    const allowAll = await promptManyHosts(safeHosts.length);
    allowedHosts = allowAll ? [...safeHosts] : [];
  } else {
    allowedHosts = [];
    for (const host of safeHosts) {
      // Each prompt is modal; they must appear one at a time, never all at
      // once, so this loop is deliberately sequential rather than
      // `Promise.all`-ed.
      const allowed = await promptHost(host);
      if (allowed) allowedHosts.push(host);
    }
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

  // C-3: a FULL decline (no host ended up allowed) is deliberately NOT
  // persisted. Persisting `{key, allowedHosts: []}` would otherwise disable
  // network for this note's exact current code FOREVER — a single
  // mis-click on "Don't allow" (or declining the unknown-hosts gate) would
  // silently and permanently suppress every future prompt, with no stored
  // record even hinting that happened and no way to revoke it short of
  // editing the code (which changes the grant key anyway). Only ever
  // writing a grant with at least one allowed host means a full decline
  // simply re-prompts on the next Run press, exactly like a first run — the
  // ordinary, recoverable outcome. A PARTIAL grant (at least one host
  // allowed) is still persisted normally, and `clearGrantForDocument` below
  // gives an explicit way to revoke a persisted grant when the user wants a
  // fresh prompt without changing the note's code.
  if (finalAllowedHosts.length > 0) {
    await writeGrant(memento, documentKey, {
      key,
      allowedHosts: finalAllowedHosts,
    });
  }

  return { allowedHosts: finalAllowedHosts };
}

/**
 * Clears the persisted grant (if any) for `documentKey` — the
 * `markii.resetScriptGrants` command's whole implementation (C-3): with no
 * stored record, `runGrantFlow`'s next call for this document is
 * indistinguishable from a first run, so it prompts fresh for every host
 * again. A no-op, not an error, when there is nothing stored for this
 * document.
 */
export async function clearGrantForDocument(
  memento: GrantMemento,
  documentKey: string,
): Promise<void> {
  const all = readAllGrants(memento);
  if (!hasOwn(all, documentKey)) return;
  const next = { ...all };
  delete next[documentKey];
  await memento.update(GRANTS_STORAGE_KEY, next);
}
