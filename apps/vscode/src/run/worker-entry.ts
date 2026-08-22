/**
 * The `worker_thread` entry point for slice 1 of the extension's v2 Run
 * arc (docs: GitHub issue #1's locked design comment). This file is
 * vscode-free — it never imports `vscode` and knows nothing about VS
 * Code's API — so it can be unit-tested directly with Vitest (spawned as a
 * REAL `node:worker_threads` worker, exercising the real wasmoon sandbox)
 * and, unmodified, be the bundled worker `esbuild.config.mjs` produces for
 * the packaged extension.
 *
 * ## Why a whole worker per run
 *
 * The design (docs/security.md's isolate requirement) is "one ephemeral
 * worker per run": the host spawns a fresh thread, this file boots
 * `@markii/lua` + `@markii/runtime` once, runs exactly one batch, posts
 * back exactly one result message, and the whole thread is expected to be
 * torn down by the host afterward (`run-host.ts`) regardless of how this
 * run went. That is what makes the external wall-clock watchdog
 * (`worker.terminate()`) an unconditional, always-available kill switch:
 * it can never be blocked by anything this file's own code does, because
 * `terminate()` acts on the OS/V8 thread itself, not on anything
 * cooperative running inside it.
 *
 * ## Never an unhandled rejection
 *
 * Every path through `main()` below is wrapped so that ANY failure —
 * a malformed job message, `parse()` throwing on pathological input,
 * `runDocumentScripts` itself misbehaving — becomes an ordinary result
 * message carrying a synthetic failure, never a thrown/rejected error that
 * could surface as an "Unhandled Promise Rejection" on the worker thread
 * (which Node would otherwise report noisily, or in the worst case treat
 * as fatal depending on the host's process-wide `--unhandled-rejections`
 * setting). `run-host.ts` therefore never needs an `unhandledRejection`
 * listener on the worker to stay safe.
 */
import { parentPort } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { extractScripts, parse } from '@markii/core';
import {
  createValueStore,
  runDocumentScripts,
  type FailureKind,
  type RunSummaryEntry,
} from '@markii/runtime';
import {
  createLuaExecutor,
  DEFAULT_MAX_FETCH_BYTES,
  type CacheEntry,
  type CacheProvider,
  type NetProvider,
  type NetResponse,
} from '@markii/lua';

/** The one job message this worker ever receives, posted once by `run-host.ts`. */
export interface RunJob {
  text: string;
  /** Hostnames (exact match, case-insensitive) this run's `net.*` calls may reach. */
  netAllowlist: string[];
  /** The persisted `cache.get` state to seed this run with (see `./script-requirements.ts`'s sibling host-side persistence). */
  cacheSnapshot: Record<string, CacheEntry>;
  /**
   * Optional resource-limit overrides, forwarded verbatim to
   * `createLuaExecutor`'s `limits`/`maxFetchBytes`. Left `undefined`, the
   * sandbox's own defaults (`@markii/lua`'s `DEFAULT_LIMITS`/
   * `DEFAULT_MAX_FETCH_BYTES`) apply.
   */
  limits?: {
    maxFetchBytes?: number;
    wallClockMs?: number;
    maxInstructions?: number;
    maxMemoryBytes?: number;
  };
}

/** One failed script, in the shape the host needs to drive the grant/UI flow — never a raw thrown error. */
export interface RunFailure {
  /** The script's declared `name`, or `'<document>'` for a failure that happened outside any single script (e.g. the text failed to parse). */
  name: string;
  message: string;
  kind: FailureKind;
}

/** The one result message this worker ever posts back. Every field is structured-clone-safe. */
export interface RunResult {
  /** `ValueStore.snapshot()` — every script's outcome, keyed by name. */
  values: Record<string, import('@markii/runtime').StoredValue>;
  failures: RunFailure[];
  /** The mutated cache state, to be persisted by the host for the next run. */
  cacheSnapshot: Record<string, CacheEntry>;
}

/** Bare, lowercased hostname from a URL string, or `undefined` if the URL doesn't parse. */
function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Prefix tag on every `Error` this module's `NetProvider` throws for a
 * policy denial (an ungranted host, a redirect off the allowlist, too many
 * redirects, an over-size response). This is NOT the same kind of denial as
 * `@markii/lua`'s own `netGrants` check inside `buildCapabilities` (which
 * records on its own out-of-band `CapabilityDenials` handle and is caught
 * there) — a denial detected HERE happens inside this provider's own `get`/
 * `post`/`patch`, one level below that check, so it surfaces from
 * `thread.run()` as an ordinary thrown error and would otherwise be
 * misclassified as a `'script-error'` (adversarial finding B-3). `runJob`
 * below scans for this tag on every failed script/value and reclassifies it
 * as `'capability-denied'` — a net-provider policy refusal is a permission
 * problem, never a bug in the script.
 */
const NET_DENIAL_TAG = 'MARKII_NET_DENIED';

/** A tagged denial — see `NET_DENIAL_TAG`'s doc comment. */
function netDenied(message: string): Error {
  return new Error(`${NET_DENIAL_TAG}: ${message}`);
}

/** A tagged failure carries `NET_DENIAL_TAG` in its message — see `NET_DENIAL_TAG`'s doc comment. Never throws. */
function isNetDenialMessage(message: string | undefined): boolean {
  return message !== undefined && message.includes(NET_DENIAL_TAG);
}

/**
 * A same-hop, same-host redirect chain is capped at this many hops (B-1):
 * an allowed host is free to redirect a handful of times (a login/CDN
 * bounce is common), but an unbounded chain is itself a resource-abuse
 * shape worth refusing outright rather than following forever.
 */
const MAX_REDIRECTS = 5;

/**
 * Reads `response`'s body, bounded to `maxFetchBytes` (B-2): a
 * `content-length` header over the cap is rejected WITHOUT reading
 * anything, and otherwise the body is streamed and the read is aborted
 * (via `controller`, the same `AbortController` the triggering `fetch` was
 * given) the moment the running byte total exceeds the cap — the whole
 * response is never buffered first. This mirrors the denial
 * `@markii/lua`'s own `maxFetchBytes` cap already produces for an
 * over-size response (see `NET_DENIAL_TAG`'s doc comment on why this
 * provider's OWN cap must exist at all: the sandbox's cap runs on the text
 * this function already returned, too late to bound the read itself).
 */
async function readBoundedBody(
  response: Response,
  maxFetchBytes: number,
  controller: AbortController,
): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const declared = Number(declaredLength);
    if (Number.isFinite(declared) && declared > maxFetchBytes) {
      throw netDenied(
        `response declares ${declared} bytes, exceeding the ${maxFetchBytes}-byte cap`,
      );
    }
  }

  const body = response.body;
  if (!body) {
    // No body stream at all (e.g. a HEAD-shaped 204) — nothing to bound.
    return response.text();
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxFetchBytes) {
      controller.abort();
      throw netDenied(`response exceeds the ${maxFetchBytes}-byte cap`);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

/**
 * The worker's `NetProvider` (`@markii/lua`): plain Node `fetch`, gated to
 * `allowlist` for every one of `get`/`post`/`patch` — one allowlist governs
 * all three (docs/security.md: "the per-host allowlist is the real
 * boundary", not a GET/POST distinction). This is DEFENSE IN DEPTH, not the
 * primary gate — the primary gate is `netGrants` passed to
 * `createLuaExecutor` below, which `@markii/lua`'s `buildCapabilities`
 * already enforces before this provider is ever called (a disallowed host
 * never reaches here at all; it comes back as the standard
 * `'capability-denied'` failure kind, recorded through `@markii/lua`'s
 * non-spoofable denial-recording path — see `capabilities.ts`). Three
 * things this provider still checks/bounds on its own because
 * `buildCapabilities` cannot see them:
 *   - the allowlist is re-checked here too, so this provider is safe to
 *     reuse on its own (e.g. in a future capability) without relying on a
 *     caller to have already gated it;
 *   - a redirect is followed manually (`redirect: 'manual'`), never by
 *     `fetch` itself, and EVERY hop's target host is checked against the
 *     same allowlist BEFORE that hop is ever requested — an allowed host
 *     redirecting the request elsewhere is exactly the SSRF shape a
 *     host-string allowlist is meant to close, and `buildCapabilities` only
 *     ever sees the ORIGINAL request URL, never where a 3xx response
 *     actually sent the request. A hop landing on a non-allowed host is
 *     refused WITHOUT that hop's request ever being made (B-1);
 *   - the response body is read bounded to `maxFetchBytes`, never buffered
 *     whole first — see `readBoundedBody` (B-2).
 */
function createNetProvider(
  allowlist: readonly string[],
  maxFetchBytes: number,
): NetProvider {
  const allowed = new Set(allowlist.map((host) => host.toLowerCase()));

  async function fetchAllowed(
    startUrl: string,
    method: string,
    body: string | undefined,
  ): Promise<NetResponse> {
    let url = startUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const host = hostnameOf(url);
      if (!host || !allowed.has(host)) {
        throw netDenied(`host "${host ?? url}" is not on the run's allowlist`);
      }

      const controller = new AbortController();
      const response = await fetch(url, {
        method,
        body,
        redirect: 'manual',
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw netDenied('redirect response carried no Location header');
        }
        let nextUrl: string;
        try {
          nextUrl = new URL(location, url).toString();
        } catch {
          throw netDenied(
            'redirect response carried an unparseable Location header',
          );
        }
        const nextHost = hostnameOf(nextUrl);
        if (!nextHost || !allowed.has(nextHost)) {
          throw netDenied(
            `redirected to disallowed host "${nextHost ?? nextUrl}"`,
          );
        }
        url = nextUrl;
        continue;
      }

      const responseBody = await readBoundedBody(
        response,
        maxFetchBytes,
        controller,
      );
      return { status: response.status, body: responseBody };
    }
    throw netDenied(`exceeded ${MAX_REDIRECTS} redirects`);
  }

  return {
    get: (url) => fetchAllowed(url, 'GET', undefined),
    post: (url, requestBody) => fetchAllowed(url, 'POST', requestBody),
    patch: (url, requestBody) => fetchAllowed(url, 'PATCH', requestBody),
  };
}

/**
 * An in-memory `CacheProvider` (`@markii/lua`) seeded from `snapshot` at
 * construction and readable back out afterward via `.snapshot()` — the
 * "snapshot-in/snapshot-out" design from the locked run-arc comment. No
 * disk/IndexedDB access here: persisting the returned snapshot across runs
 * is `run-host.ts`'s caller's job (extension storage, in the real
 * extension).
 */
function createSnapshotCacheProvider(snapshot: Record<string, CacheEntry>): {
  provider: CacheProvider;
  snapshot: () => Record<string, CacheEntry>;
} {
  const store = new Map<string, CacheEntry>(Object.entries(snapshot));
  return {
    provider: {
      async get(key: string): Promise<CacheEntry | undefined> {
        return store.get(key);
      },
      async set(key: string, entry: CacheEntry): Promise<void> {
        store.set(key, entry);
      },
    },
    snapshot: () => Object.fromEntries(store),
  };
}

/**
 * Resolves the `wasmUri` to hand `createLuaExecutor` (forwarded to
 * `@markii/lua`'s `runScript` -> `createEmptyLuaEngine` -> wasmoon's
 * `LuaFactory`). In the BUNDLED extension, `esbuild.config.mjs`'s worker
 * build copies wasmoon's `glue.wasm` next to this file's compiled output
 * (`dist/run/glue.wasm`) specifically so this lookup succeeds; in
 * dev/Vitest (this file run straight from `src/run/`, no copy step has
 * ever run), the file is absent and `undefined` is returned, letting
 * wasmoon fall back to its own default Node resolution (the real
 * `node_modules/wasmoon/dist/glue.wasm`) — see `@markii/lua`'s
 * `createEmptyLuaEngine` doc comment for why `undefined` is always safe to
 * pass here.
 */
function resolveWasmUri(): string | undefined {
  const candidate = path.join(__dirname, 'glue.wasm');
  return existsSync(candidate) ? candidate : undefined;
}

function describeThrown(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Runs one job to completion, never throwing — see this module's top doc comment. */
async function runJob(job: RunJob): Promise<RunResult> {
  const cache = createSnapshotCacheProvider(job.cacheSnapshot ?? {});
  const netAllowlist = job.netAllowlist ?? [];
  // The SAME cap governs this worker's own bounded body read
  // (`readBoundedBody`, B-2) and `@markii/lua`'s own `maxFetchBytes` check —
  // computed once, here, rather than letting each side default
  // independently, so the two can never quietly disagree.
  const maxFetchBytes = job.limits?.maxFetchBytes ?? DEFAULT_MAX_FETCH_BYTES;
  const net = createNetProvider(netAllowlist, maxFetchBytes);

  const tree = parse(job.text);
  const scripts = extractScripts(tree);

  const executor = createLuaExecutor({
    net,
    // One allowlist governs GET/POST/PATCH alike (B-6, docs/security.md:
    // "the per-host allowlist is the real boundary") — the grant prompt's
    // wording ("can send data to <host>") already promises exactly this,
    // so POST/PATCH must be wired to the same hosts GET is, not silently
    // disabled.
    netGrants: { get: netAllowlist, post: netAllowlist },
    cache: cache.provider,
    maxFetchBytes,
    limits: {
      ...(job.limits?.wallClockMs !== undefined
        ? { wallClockMs: job.limits.wallClockMs }
        : {}),
      ...(job.limits?.maxInstructions !== undefined
        ? { maxInstructions: job.limits.maxInstructions }
        : {}),
      ...(job.limits?.maxMemoryBytes !== undefined
        ? { maxMemoryBytes: job.limits.maxMemoryBytes }
        : {}),
    },
    wasmUri: resolveWasmUri(),
  });

  const store = createValueStore();
  const summary = await runDocumentScripts({
    scripts,
    executor,
    trigger: 'manual',
    store,
  });

  const failures: RunFailure[] = summary.results
    .filter(
      (entry: RunSummaryEntry): entry is RunSummaryEntry & { error: string } =>
        entry.status === 'error',
    )
    .map((entry) => {
      const message = entry.error ?? 'script failed';
      const kind = entry.failureKind ?? 'script-error';
      return {
        name: entry.name,
        message,
        // B-3: a net-provider policy denial (a blocked redirect, an
        // over-size body, too many hops) throws a plain `Error` one level
        // below `@markii/lua`'s own capability-denial recording (see
        // `NET_DENIAL_TAG`'s doc comment above), so it would otherwise
        // land here as an ordinary `'script-error'`. Reclassify it as a
        // capability denial — the note asked for something the allowlist
        // refused, not a bug in the script.
        kind: isNetDenialMessage(message) ? 'capability-denied' : kind,
      };
    });

  // Same reclassification for the value store's own `failureKind` — every
  // `StoredValue` with `status: 'error'` was populated from the exact same
  // `runOne` outcome the `failures` entry above came from, so a net denial
  // must be reclassified there too (a renderer branches on
  // `StoredValue.failureKind` directly — see `@markii/react`'s
  // `failure-presentation.ts`).
  const values: Record<string, import('@markii/runtime').StoredValue> = {};
  for (const [name, entry] of Object.entries(store.snapshot())) {
    values[name] =
      entry.status === 'error' && isNetDenialMessage(entry.error)
        ? { ...entry, failureKind: 'capability-denied' }
        : entry;
  }

  return {
    values,
    failures,
    cacheSnapshot: cache.snapshot(),
  };
}

/** Turns any unexpected internal failure into an ordinary result — see the top doc comment's "never an unhandled rejection" guarantee. */
function resultForInternalError(
  err: unknown,
  fallbackCacheSnapshot: Record<string, CacheEntry>,
): RunResult {
  return {
    values: {},
    failures: [
      {
        name: '<document>',
        message: describeThrown(err),
        kind: 'script-error',
      },
    ],
    cacheSnapshot: fallbackCacheSnapshot,
  };
}

function isRunJob(value: unknown): value is RunJob {
  if (typeof value !== 'object' || value === null) return false;
  const job = value as Record<string, unknown>;
  return (
    typeof job.text === 'string' &&
    Array.isArray(job.netAllowlist) &&
    job.netAllowlist.every((h) => typeof h === 'string') &&
    typeof job.cacheSnapshot === 'object' &&
    job.cacheSnapshot !== null
  );
}

async function main(): Promise<void> {
  if (!parentPort) {
    // Not actually running as a worker thread (e.g. required directly by
    // mistake) — nothing to do, and nothing to post a result to.
    return;
  }
  const port = parentPort;

  port.once('message', (message: unknown) => {
    void (async () => {
      if (!isRunJob(message)) {
        port.postMessage(
          resultForInternalError(
            new Error('worker received a malformed job message'),
            {},
          ),
        );
        return;
      }
      try {
        const result = await runJob(message);
        port.postMessage(result);
      } catch (err) {
        port.postMessage(
          resultForInternalError(err, message.cacheSnapshot ?? {}),
        );
      }
    })();
  });
}

void main();
