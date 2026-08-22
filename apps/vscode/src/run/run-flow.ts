/**
 * Slice 2's top-level orchestration for one `markii.runScripts` press:
 * extract requirements -> run the grant flow -> read/spawn/persist the
 * cache snapshot -> shape the result for the `values` wire message
 * (`../protocol.ts`). Deliberately vscode-free, like every other module
 * under `./`: the ONLY vscode-shaped things this needs (a Memento, a
 * `spawnRun`-like runner, and two prompt functions) arrive as plain
 * parameters, so `extension.ts`/`preview-panel.ts` — the only files
 * allowed to import `vscode` — reduce to supplying those and posting the
 * resulting message. See `./grant-flow.ts` and `./run-host.ts` for the
 * pieces this file composes.
 */
import { extractRunRequirements } from './script-requirements.js';
import { runGrantFlow } from './grant-flow.js';
import type {
  GrantMemento,
  PromptHost,
  PromptUnknownHosts,
} from './grant-flow.js';
import type { RunResult, SpawnRunOptions } from './run-host.js';
import type { ValuesFailure } from '../protocol.js';
import type { StoredValue } from '@markii/runtime';

/**
 * Strips a `StoredValue`'s `error` field before it ever reaches the wire
 * (D-1): `.error` is whatever text the executor happened to produce —
 * a raw Lua traceback, or (worse, per B-3) a net-provider denial message
 * that can embed the actual request URL/host — and none of that is meant
 * for the rendered page (AGENTS.md's cleanliness principle: quiet markers,
 * never error dumps). This mirrors exactly what `runOnce` below already
 * does to `RunResult.failures` (reduced to `{name, kind}`, never the raw
 * message): `failureKind` is kept, so a renderer (`@markii/react`'s
 * `failure-presentation.ts`) still branches on the closed `FailureKind`
 * taxonomy — nothing in this reference renderer ever reads `.error` for
 * display, only for a value that DIDN'T fail (`status !== 'error'`), where
 * `error` is absent anyway.
 */
function scrubStoredValueForWire(value: StoredValue): StoredValue {
  if (value.status !== 'error' || value.error === undefined) return value;
  const { error: _error, ...rest } = value;
  return rest;
}

function scrubValuesForWire(
  values: Record<string, StoredValue>,
): Record<string, StoredValue> {
  const scrubbed: Record<string, StoredValue> = {};
  for (const [name, value] of Object.entries(values)) {
    scrubbed[name] = scrubStoredValueForWire(value);
  }
  return scrubbed;
}

/** A `CacheEntry`-keyed snapshot, structurally — this module never imports `@markii/lua` just for the type; it only ever passes the value through. */
export type CacheSnapshot = Record<string, unknown>;

/**
 * A sane upper bound on a persisted cache snapshot: real cached `net.*`
 * responses are small JSON payloads, so the cap exists to guarantee a
 * runaway/adversarial script can never grow `workspaceState` without
 * bound. A snapshot over this size is DROPPED, not truncated — a partial
 * cache would silently look valid while missing entries a script assumed
 * were still there, which is worse than starting the next run with none
 * at all.
 */
export const MAX_CACHE_SNAPSHOT_BYTES = 1_000_000;

/** The single `workspaceState`/Memento key a document's cache snapshot lives under. */
export function cacheStorageKeyFor(documentKey: string): string {
  return `markii.runCache:${documentKey}`;
}

/** A plausible cache-snapshot shape read back from storage — never trusts it further than "is this a plain object at all" (an old/foreign/corrupt value degrades to "no cache", matching this whole module's fail-safe posture). */
export function isCacheSnapshotShape(value: unknown): value is CacheSnapshot {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The JSON text for `snapshot`, or `undefined` when it must be dropped
 * instead of persisted: either it isn't serializable at all (a value
 * `JSON.stringify` cannot handle), or its serialized size exceeds
 * `MAX_CACHE_SNAPSHOT_BYTES`. Callers write `undefined` back to storage in
 * that case — see `MAX_CACHE_SNAPSHOT_BYTES`'s doc comment on why a partial
 * write is never attempted.
 */
export function serializeCacheSnapshotIfSmallEnough(
  snapshot: CacheSnapshot,
): string | undefined {
  let serialized: string;
  try {
    serialized = JSON.stringify(snapshot);
  } catch {
    return undefined;
  }
  return serialized.length <= MAX_CACHE_SNAPSHOT_BYTES ? serialized : undefined;
}

export interface RunOnceOptions {
  /** Stable identity for the note this run belongs to — `vscode.Uri.toString()` of the document, in the real adapter. Shared with `./grant-flow.ts`'s `documentKey`. */
  documentKey: string;
  text: string;
  memento: GrantMemento;
  promptHost: PromptHost;
  promptUnknownHosts: PromptUnknownHosts;
  /** Injected so this function is testable with a fake worker runner — the real adapter passes `./run-host.ts`'s `spawnRun`. */
  spawnRun: (options: SpawnRunOptions) => Promise<RunResult>;
  timeoutMs: number;
}

export interface RunOnceResult {
  values: Record<string, StoredValue>;
  failures: ValuesFailure[];
}

/**
 * Runs one manual pass of `options.text`'s scripts end to end: the grant
 * flow decides the net allowlist (prompting only on a miss), the persisted
 * cache snapshot seeds the run, and the run's own (possibly mutated) cache
 * snapshot is written back — capped, never partially. The returned shape
 * is exactly what the `values` wire message (`../protocol.ts`) needs,
 * minus the `revision` tag, which the caller (who knows what revision this
 * run was actually performed against) attaches. Every `StoredValue`'s raw
 * `error` text is stripped before it is returned (D-1, `scrubValuesForWire`
 * above) — same treatment `failures` already got.
 */
export async function runOnce(options: RunOnceOptions): Promise<RunOnceResult> {
  const requirements = extractRunRequirements(options.text);

  const grant = await runGrantFlow({
    documentKey: options.documentKey,
    requirements,
    memento: options.memento,
    promptHost: options.promptHost,
    promptUnknownHosts: options.promptUnknownHosts,
  });

  const cacheKey = cacheStorageKeyFor(options.documentKey);
  const rawCache = options.memento.get<unknown>(cacheKey);
  const cacheSnapshot = isCacheSnapshotShape(rawCache) ? rawCache : {};

  const result = await options.spawnRun({
    text: options.text,
    netAllowlist: grant.allowedHosts,
    cacheSnapshot: cacheSnapshot as SpawnRunOptions['cacheSnapshot'],
    timeoutMs: options.timeoutMs,
  });

  const nextSnapshotText = serializeCacheSnapshotIfSmallEnough(
    result.cacheSnapshot,
  );
  await options.memento.update(
    cacheKey,
    nextSnapshotText === undefined ? undefined : result.cacheSnapshot,
  );

  return {
    values: scrubValuesForWire(result.values),
    failures: result.failures.map((failure) => ({
      name: failure.name,
      kind: failure.kind,
    })),
  };
}
