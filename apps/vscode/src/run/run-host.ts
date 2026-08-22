/**
 * The host-side runner for slice 1 of the extension's v2 Run arc (GitHub
 * issue #1's locked design comment). Plain Node — no `vscode` import — so
 * it is unit-testable with Vitest and reusable unchanged once slice 2
 * wires a command/button to it.
 *
 * `spawnRun` is the whole contract: give it a note's text, its net
 * allowlist, a persisted cache snapshot, and a deadline; get back a
 * `RunResult` that never rejects. The EXTERNAL watchdog
 * (`setTimeout` -> `worker.terminate()`) is what makes this safe to call
 * against untrusted script content — `./worker-entry.ts`'s own in-VM
 * limits are a second, INNER layer (docs/security.md), but this file's job
 * is the outer one: a kill switch that works even if everything inside the
 * worker is compromised or wedged, because `terminate()` acts on the
 * thread from outside it.
 */
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

import type { CacheEntry } from '@markii/lua';
import type { RunJob, RunResult } from './worker-entry.js';

export type { RunJob, RunResult, RunFailure } from './worker-entry.js';

export interface SpawnRunOptions {
  text: string;
  netAllowlist: string[];
  cacheSnapshot: Record<string, CacheEntry>;
  /** Wall-clock budget for the whole run, enforced by this file's own external watchdog — never delegated to the worker. */
  timeoutMs: number;
  /** Forwarded verbatim to the worker's `RunJob.limits` (the sandbox's own, INNER resource caps) — see `./worker-entry.ts`. */
  limits?: RunJob['limits'];
  /**
   * Overrides the worker entry file this run spawns. Left unset,
   * `defaultWorkerPath` resolves it: the bundled `dist/run/worker.js` the
   * packaged extension ships, or (in dev/Vitest, where no bundle exists
   * yet) the sibling `worker-entry.ts` run straight from source via `tsx`.
   */
  workerPath?: string;
}

/** `execArgv` needed to run a `.ts` worker entry directly (dev/Vitest only) — see `./worker-entry.ts`'s doc comment on why a plain `node` `.ts` import can't resolve this repo's `@markii/*` bare specifiers or its `./foo.js` -> `./foo.ts` import convention on its own. `--require tsx/cjs` (rather than `tsx/esm`) is deliberate: empirically, the ESM loader hook deadlocks Node's CJS/ESM interop translator for a worker thread requiring `.js`-suffixed relative imports that resolve to `.ts` files (this repo's convention throughout `@markii/*`), while the CJS `require` hook has no such issue. */
const TSX_DEV_EXEC_ARGV = ['--require', 'tsx/cjs'];

/**
 * Resolves the worker entry file with no configuration required in either
 * environment this file runs in:
 * - the PACKAGED extension: `esbuild.config.mjs`'s worker build bundles
 *   `worker-entry.ts` to `dist/run/worker.js`; since this file (bundled
 *   into `dist/extension.js`) has `__dirname === dist/` at runtime (esbuild
 *   flattens a whole bundle into one file, so every module inside it
 *   shares the bundle's own `__dirname` — verified empirically, see this
 *   slice's implementation notes), `dist/run/worker.js` is exactly
 *   `path.join(__dirname, 'run', 'worker.js')`.
 * - dev/Vitest: this file runs unbundled from `src/run/`, so `__dirname`
 *   is that real source directory and the sibling `worker-entry.ts` is
 *   used directly (with `TSX_DEV_EXEC_ARGV`, below).
 */
export function defaultWorkerPath(): string {
  const bundled = path.join(__dirname, 'run', 'worker.js');
  if (existsSync(bundled)) return bundled;

  const colocated = path.join(__dirname, 'worker.js');
  if (existsSync(colocated)) return colocated;

  const devSource = path.join(__dirname, 'worker-entry.ts');
  if (existsSync(devSource)) return devSource;

  throw new Error(
    'spawnRun: could not resolve the worker entry file (looked for ' +
      `${bundled}, ${colocated}, ${devSource}) — pass workerPath explicitly`,
  );
}

function execArgvFor(workerPath: string): string[] | undefined {
  return workerPath.endsWith('.ts') ? TSX_DEV_EXEC_ARGV : undefined;
}

/**
 * `resourceLimits.maxOldGenerationSizeMb` for the spawned worker (A-1): a
 * script's own Lua memory is already capped in-VM (`@markii/lua`'s
 * `limits.maxMemoryBytes`), but nothing previously bounded the JS/V8 heap
 * OF THE WORKER ITSELF — a large marshaled return value, an oversize
 * fetched/cached JSON payload, or any other JS-side allocation this file's
 * own code performs could still OOM that heap. Without an explicit
 * `resourceLimits`, a V8 OOM inside a `worker_threads` worker is fatal to
 * the WHOLE PROCESS (the extension host), not just that thread — exactly
 * the failure mode the external, always-available `terminate()` watchdog
 * above is meant to make impossible for a wedged/hostile script. 128MB is
 * comfortably above what one script's marshaled result or one cached
 * fetch response (`@markii/lua`'s `DEFAULT_MAX_FETCH_BYTES`, 2MB) should
 * ever need, while still being small enough that a runaway allocation hits
 * this cap, and the resulting worker `'error'` event, long before it could
 * threaten the host process's own heap.
 */
const WORKER_MAX_OLD_GENERATION_SIZE_MB = 128;

function describeThrown(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Spawns one ephemeral worker, runs `options.text`'s scripts in it under
 * the manual tier, and resolves with the outcome. NEVER REJECTS — every
 * way this can go wrong (a message never arrives, the worker throws, the
 * worker exits on its own, the external watchdog fires) resolves with an
 * ordinary `RunResult` carrying a synthetic failure instead. Settlement is
 * exactly-once: whichever of `message` / `error` / `exit` / the watchdog
 * fires FIRST wins; every later event on the same worker is a no-op (the
 * `settled` guard below), so there is no risk of a double-`resolve` race
 * even though several of these could in principle fire in close
 * succession (e.g. `terminate()` after settling on `message` still
 * produces its own `exit` event).
 */
export async function spawnRun(options: SpawnRunOptions): Promise<RunResult> {
  const workerPath = options.workerPath ?? defaultWorkerPath();
  const execArgv = execArgvFor(workerPath);

  const job: RunJob = {
    text: options.text,
    netAllowlist: options.netAllowlist,
    cacheSnapshot: options.cacheSnapshot,
    ...(options.limits !== undefined ? { limits: options.limits } : {}),
  };

  return new Promise<RunResult>((resolve) => {
    let settled = false;
    let watchdogFired = false;

    const worker = new Worker(workerPath, {
      ...(execArgv ? { execArgv } : {}),
      resourceLimits: {
        maxOldGenerationSizeMb: WORKER_MAX_OLD_GENERATION_SIZE_MB,
      },
    });

    const watchdog = setTimeout(() => {
      watchdogFired = true;
      // Fire-and-forget: `terminate()`'s own returned promise resolves
      // once the thread is actually gone, but we don't need to wait on
      // it here -- the worker's `exit` event (handled below) is what
      // settles this run's promise, and it fires as part of the same
      // termination sequence.
      void worker.terminate();
    }, options.timeoutMs);
    // Never let this timer keep the host process/extension-host alive on
    // its own.
    watchdog.unref?.();

    function settle(result: RunResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      resolve(result);
      // Ephemeral-per-run: tear the worker down once we have ANY outcome,
      // including a normal successful `message`. `terminate()` on a
      // worker that has already exited (or is already exiting) is a safe
      // no-op, per Node's `worker_threads` documentation.
      void worker.terminate();
    }

    worker.once('message', (result: RunResult) => {
      settle(result);
    });

    worker.once('error', (err) => {
      settle({
        values: {},
        failures: [
          {
            name: '<worker>',
            message: describeThrown(err),
            kind: 'script-error',
          },
        ],
        cacheSnapshot: options.cacheSnapshot,
      });
    });

    worker.once('exit', (code) => {
      // A `message` already having settled this run is the ordinary
      // happy path -- `settle`'s own `terminate()` call produces exactly
      // this `exit` event, and `settle`'s guard makes it a no-op here.
      if (settled) return;

      if (watchdogFired) {
        settle({
          values: {},
          failures: [
            {
              name: '<document>',
              message: `run exceeded its ${options.timeoutMs}ms watchdog and was terminated`,
              kind: 'limit',
            },
          ],
          cacheSnapshot: options.cacheSnapshot,
        });
        return;
      }

      // The worker exited on its own, without the watchdog and without
      // ever posting a result -- e.g. a hostile/rigged script that calls
      // `process.exit()` directly (Node terminates only the calling
      // worker thread for that, not the host process, but this run still
      // never got a proper `RunResult` out of it). Resolve, never
      // reject -- see this function's doc comment.
      settle({
        values: {},
        failures: [
          {
            name: '<worker>',
            message: `worker exited unexpectedly (code ${String(code)}) before returning a result`,
            kind: 'script-error',
          },
        ],
        cacheSnapshot: options.cacheSnapshot,
      });
    });

    worker.postMessage(job);
  });
}
