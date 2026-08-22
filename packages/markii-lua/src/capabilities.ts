import type { ScriptView } from '@markii/bundle';
import { LuaMultiReturn } from 'wasmoon';
import { CAPABILITY_ERROR_TAG, MARSHAL_ERROR_TAG } from './errors.js';
import { buildJsonDecodePrelude } from './json-decode.js';
import {
  buildMarshalPrelude,
  checkJsonWithinLimits,
  DEFAULT_MARSHAL_LIMITS,
  finalizeMarshaledValue,
  type MarshalLimits,
} from './marshal.js';

/** A GET/POST/PATCH result handed back to Lua as `{status=..., body=...}`. */
export interface NetResponse {
  status: number;
  body: string;
}

/**
 * Host-provided network primitive. The runtime never imports a global
 * `fetch` or reaches the network on its own — this is injected by the
 * host, which is where SSRF/allowlist policy actually lives (spec §10).
 * `net.fetch_json`/`net.post`/`net.patch` below are a thin, capability- and
 * size-checked Lua-facing wrapper around whatever `provider` does.
 */
export interface NetProvider {
  get(url: string): Promise<NetResponse>;
  post?(url: string, body: string): Promise<NetResponse>;
  patch?(url: string, body: string): Promise<NetResponse>;
}

/** One cached entry: the stored value plus when it was stored, for TTL comparison. */
export interface CacheEntry {
  value: unknown;
  storedAtMs: number;
}

/**
 * Host-provided cache primitive backing `cache.get(key, ttl, fn)`. Real
 * persistence (bundle `cache/`, IndexedDB, whatever the host uses) is the
 * host's concern; this package only defines the read-if-fresh-else-run-fn
 * contract.
 */
export interface CacheProvider {
  get(key: string): Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): Promise<void>;
}

/** Spec §8's two-tier gate. `'manual'` = explicit run/run-all click, all grants apply. `'auto'` = on-open or scheduled, read-only regardless of what was granted. */
export type CapabilityTier = 'manual' | 'auto';

/**
 * Hostnames this run may reach, ALREADY intersected by the caller (manifest
 * ∩ user grant — same pattern as `@markii/bundle`'s `createScriptView`, DEFECT
 * 10). This module does not re-derive grants from a manifest; it trusts
 * `get`/`post` as the final, effective allowlist for this one run.
 */
export interface NetGrants {
  get: readonly string[];
  post: readonly string[];
}

export interface CapabilityConfig {
  tier: CapabilityTier;
  net?: NetProvider;
  netGrants?: NetGrants;
  cache?: CacheProvider;
  /** Bundle-scoped filesystem view (spec §11) — already capability-restricted by `@markii/bundle`'s `createScriptView`; this module delegates to it, never re-implements the path-jail or write policy. */
  bundle?: ScriptView;
  maxFetchBytes?: number;
  /**
   * Depth/node budget for a `net.fetch_json` response, checked (via
   * `./marshal`'s `checkJsonWithinLimits`) against the parsed JSON BEFORE
   * the raw body text is ever handed to Lua's `__smd_json_decode`
   * (`./json-decode`) — see that module's doc comment for the full
   * rationale (GitHub issue #6). Defaults to `./marshal`'s
   * `DEFAULT_MARSHAL_LIMITS`, the same defaults `runScript` already uses
   * for the return-value marshal walk, so a fetched response and a
   * script's own return value are held to one shared limit by default,
   * not two independently-tuned ones.
   */
  marshalLimits?: MarshalLimits;
}

export const DEFAULT_MAX_FETCH_BYTES = 2_000_000;

/** One genuine capability denial, as recorded by `buildCapabilities`' `denials` handle — see its doc comment. */
export interface CapabilityDenial {
  reason: 'denied' | 'tier-blocked';
  message: string;
}

/**
 * Non-spoofable, out-of-band record of the LAST genuine capability denial
 * that happened during one `buildCapabilities` call's lifetime (i.e. one
 * `runScript` call — see `./sandbox`). This is a plain JS closure: no Lua
 * value, no metatable, nothing a script running in the sandbox can ever
 * read or write, mirroring the discipline `./limits`' breach flag already
 * uses for resource-limit kills. `sandbox.ts`'s `classifyRuntimeError`
 * consults `last()` — never any error message string that crossed the Lua
 * boundary — to decide whether a failed run was genuinely a `'capability'`
 * kind, and if so which `capability` flavor (`'denied'` vs `'tier-blocked'`).
 */
export interface CapabilityDenials {
  last(): CapabilityDenial | undefined;
}

function capabilityError(message: string): Error {
  return new Error(`${CAPABILITY_ERROR_TAG}: ${message}`);
}

function describeThrown(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Bare hostname from a URL string, or `undefined` if the URL doesn't parse. */
function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * `Uint8Array` <-> Lua string, byte-for-byte via one JS UTF-16 code unit
 * per byte (Latin-1-style). Lua strings are themselves 8-bit-clean byte
 * arrays, but wasmoon's own JS<->Lua marshaling for strings does NOT
 * preserve embedded NUL (0x00) bytes end-to-end — verified empirically
 * (wasmoon 1.16.0): a JS string or Lua `string.char(...)` value containing
 * a `\0` is truncated at the first NUL by the time it crosses the
 * boundary, in BOTH directions (`global.set`, and a Lua value passed as an
 * argument to a host function). This is a real, currently-unclosed gap for
 * binary asset data containing NUL bytes (some binary formats do; JSON
 * cache payloads and Lua source — the two documented `bundle.*` use cases
 * per spec §9/§11 — do not). Documented here rather than silently
 * "handled": `bundle.read`/`bundle.write` should be treated as reliable
 * for text/JSON payloads and NOT YET reliable for arbitrary binary
 * containing NUL bytes. See the adversarial test asserting this exact
 * (current, imperfect) behavior so a future wasmoon upgrade that fixes it
 * is a visible, reviewed diff rather than a silent behavior change.
 */
export function bytesToLuaString(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i] ?? 0);
  }
  return out;
}

export function luaStringToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    out[i] = s.charCodeAt(i) & 0xff;
  }
  return out;
}

/**
 * Builds the raw, host-facing async functions to inject as flat globals,
 * and the trusted Lua prelude that wraps them into the ergonomic `net` /
 * `cache` / `bundle` tables the docs/spec.md host API documents (`net.fetch_json(url)`,
 * `cache.get(key, ttl, fn)`, `bundle.read/write/exists(path)`).
 *
 * ## Why "raw flat globals + a Lua prelude" instead of `global.set('net', {...})`
 *
 * The natural-looking approach — `engine.global.set('net', { fetch_json:
 * async (url) => ... })` — silently breaks async/await for any capability
 * whose Lua-facing wrapper needs to be REPLACED with a Lua closure later
 * (which `cache.get` and every `:await()`-wrapping function here need to
 * be, since raw host functions return promises that must be explicitly
 * awaited — see below). With wasmoon's default `enableProxy: true`, a
 * plain JS object passed to `global.set` becomes a live PROXY table: Lua
 * writes to it round-trip back through JS, and reading a Lua-defined
 * function back OUT of that proxy re-wraps it as a synchronous JS-callable
 * bridge (`lua_pcallk`), which cannot yield. Concretely: assigning
 * `cache.get = function(...) ... end` onto a proxied table and then
 * calling `cache.get(...)` from a script ends up invoking that Lua
 * function through the SYNCHRONOUS bridge, and if it (or anything it
 * calls) tries to `:await()` a promise, Lua raises "attempt to yield
 * across a C-call boundary" — verified empirically. Using genuine,
 * Lua-native tables (built with `{}` inside the prelude, never JS-backed)
 * avoids this entirely: every read/write of `net`/`cache`/`bundle` after
 * setup is a normal Lua table operation, no JS round trip involved.
 *
 * ## Why raw calls need `:await()` at all
 *
 * A JS async function called from Lua does NOT automatically suspend the
 * calling coroutine — wasmoon marshals its Promise into Lua as a
 * `js_promise` userdata with `:await()`/`:next()`/`:catch()` methods; the
 * CALLER must explicitly invoke `:await()` to get the resolved value
 * (verified empirically: without it, a script sees the raw promise
 * userdata, not the awaited result). Since `docs/spec.md`'s example script
 * (`local repo = net.fetch_json(url)`) is written as if this were
 * synchronous, the awaiting is done for the author, once, HERE — inside
 * the prelude's Lua wrapper — never exposed to the untrusted script.
 *
 * Each raw handle is captured into a `local` inside the prelude and the
 * matching global is set to `nil` immediately after, so it is not
 * reachable as a global by the untrusted script that runs afterward (only
 * the ergonomic wrapper closures, which close over the local, remain
 * callable).
 */
export function buildCapabilities(config: CapabilityConfig): {
  rawGlobals: Record<string, (...args: never[]) => Promise<unknown>>;
  preludeLua: string;
  denials: CapabilityDenials;
} {
  const maxFetchBytes = config.maxFetchBytes ?? DEFAULT_MAX_FETCH_BYTES;
  const marshalLimits: MarshalLimits =
    config.marshalLimits ?? DEFAULT_MARSHAL_LIMITS;
  const rawGlobals: Record<string, (...args: never[]) => Promise<unknown>> = {};
  const preludeParts: string[] = [];

  // `__smd_json_decode` (`./json-decode`) is needed by BOTH `net.fetch_json`
  // and `cache.get` (a cache hit re-enters Lua the same way a fetch result
  // does — see the `cache` section below) — injected at most once
  // regardless of how many callers need it. Re-defining the same Lua
  // global twice would be harmless (Lua allows redefining a function), but
  // there is no reason to emit the prelude source twice.
  let jsonDecodePreludeInjected = false;
  function ensureJsonDecodePrelude(): void {
    if (jsonDecodePreludeInjected) return;
    jsonDecodePreludeInjected = true;
    preludeParts.push(buildJsonDecodePrelude(marshalLimits));
  }

  // `__smd_marshal_root` (`./marshal`'s `buildMarshalPrelude`) is normally
  // injected once, unconditionally, by `sandbox.ts` — AFTER this module's
  // own prelude. `cache.get`'s internal refresh path (below) needs it
  // available too, and needs it self-contained here rather than assuming
  // that injection order: this module is exercised standalone (see
  // `capabilities.test.ts`, which never touches `sandbox.ts`), so it must
  // not depend on a caller injecting it. Re-running `sandbox.ts`'s own
  // injection afterward just redefines the same idempotent Lua functions —
  // harmless.
  let marshalPreludeInjected = false;
  function ensureMarshalPrelude(): void {
    if (marshalPreludeInjected) return;
    marshalPreludeInjected = true;
    preludeParts.push(buildMarshalPrelude(marshalLimits));
  }

  // Out-of-band denial record — see `CapabilityDenials`'s doc comment. Every
  // site below that throws a `capabilityError` records here FIRST, so
  // `sandbox.ts` can classify the failure by this JS-only signal instead of
  // by re-reading the (script-forgeable) error message.
  let lastDenial: CapabilityDenial | undefined;
  function recordDenial(
    reason: CapabilityDenial['reason'],
    message: string,
  ): void {
    lastDenial = { reason, message };
  }
  const denials: CapabilityDenials = { last: () => lastDenial };

  // --- net --------------------------------------------------------------
  // `fetch_json` and `post`/`patch` are gated INDEPENDENTLY of each other
  // (a manifest can grant POST to a host without granting it GET, or vice
  // versa), so the `net` table and each method are wired up separately
  // rather than behind one combined condition — an earlier version of
  // this function nested POST/PATCH wiring inside "if GET is granted",
  // which silently produced no `net.post` at all for a POST-only grant.
  const netGrants = config.netGrants ?? { get: [], post: [] };
  // NOTE: no longer conditioned on `config.tier === 'manual'` for the POST
  // half — under 'auto' with POST hosts granted, `net.post`/`net.patch` are
  // now wired to TIER-BLOCKED STUBS below (not left undefined), so the
  // `net` table itself must exist for those stubs to attach to.
  const netTableNeeded =
    config.net !== undefined &&
    (netGrants.get.length > 0 || netGrants.post.length > 0);

  if (netTableNeeded) {
    preludeParts.push('net = net or {}\n');
  }

  if (config.net && netGrants.get.length > 0) {
    rawGlobals.__smd_net_get_raw = (async (url: string) => {
      const host = hostnameOf(url);
      if (!host || !netGrants.get.includes(host)) {
        const message = `net access to host "${host ?? url}" not granted for GET`;
        recordDenial('denied', message);
        throw capabilityError(message);
      }
      const res = await config.net!.get(url);
      if (res.body.length > maxFetchBytes) {
        const message = `fetch response for "${url}" exceeds the ${maxFetchBytes}-byte cap`;
        recordDenial('denied', message);
        throw capabilityError(message);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(res.body);
      } catch {
        const message = `fetch response for "${url}" was not valid JSON`;
        recordDenial('denied', message);
        throw capabilityError(message);
      }
      // Depth/node budget, checked HERE on the plain parsed JS value and
      // BEFORE the raw text is ever handed to Lua — see `./json-decode`'s
      // doc comment (GitHub issue #6) for why decoding happens entirely in
      // Lua, and `MarshalLimits`' doc comment above for why this reuses the
      // same budget the return-value marshal walk already enforces.
      const budgetCheck = checkJsonWithinLimits(parsed, marshalLimits);
      if (!budgetCheck.ok) {
        const message = `fetch response for "${url}" ${budgetCheck.message}`;
        recordDenial('denied', message);
        throw capabilityError(message);
      }
      // Hand back the RAW JSON TEXT, not the parsed JS value: any object or
      // array crossing this JS->Lua boundary as-is would arrive in Lua as a
      // wasmoon `js_proxy` userdata, not a genuine table (see
      // `./json-decode`'s doc comment for the full mechanism and why that
      // breaks `type()`/`#`/marshaling a nested return value, and silently
      // raises on a `null` field read). Strings, unlike objects/arrays, are
      // scalars and cross the boundary cleanly with no proxy involved; the
      // prelude below decodes this text into a genuine Lua table entirely
      // in Lua (`__smd_json_decode`, `./json-decode`).
      return res.body;
    }) as (...args: never[]) => Promise<unknown>;

    ensureJsonDecodePrelude();
    preludeParts.push(`
local __smd_net_get = __smd_net_get_raw
-- Captured into a local HERE, at prelude-definition time (this whole
-- prelude runs once, before any untrusted script code) -- NOT resolved as
-- a dynamic global lookup inside \`net.fetch_json\`'s own body. Otherwise a
-- script could do \`__smd_json_decode = function(t) return t end\` before a
-- LATER \`net.fetch_json\` call and neuter the decoder's own depth guard and
-- array-marker stripping entirely (adversarial finding A2) -- the same
-- rebinding risk \`./json-decode\`'s own doc comment (finding A1) already
-- closes for the primitives the decoder uses internally.
local __smd_net_get_json_decode = __smd_json_decode
__smd_net_get_raw = nil
net.fetch_json = function(url) return __smd_net_get_json_decode(__smd_net_get(url):await()) end
`);
  }

  // POST/PATCH are effectful. Under the 'manual' tier, wired to the real
  // provider for hosts the effective grant set allows for POST. Under
  // 'auto', even when POST hosts ARE granted, they are wired to STUBS
  // that record a 'tier-blocked' denial and throw WITHOUT EVER reaching
  // `config.net.post`/`.patch` — this grants nothing new (the provider is
  // never called), it only makes "granted but tier-forbidden" a
  // classifiable, non-spoofable outcome instead of collapsing into an
  // ordinary "attempt to call a nil value" runtime error (spec §8: "An
  // effectful call under an auto trigger fails cleanly").
  if (
    config.tier === 'manual' &&
    config.net?.post &&
    netGrants.post.length > 0
  ) {
    rawGlobals.__smd_net_post_raw = (async (url: string, body: string) => {
      const host = hostnameOf(url);
      if (!host || !netGrants.post.includes(host)) {
        const message = `net access to host "${host ?? url}" not granted for POST`;
        recordDenial('denied', message);
        throw capabilityError(message);
      }
      const res = await config.net!.post!(url, body);
      // As with `net.fetch_json` above (GitHub issue #6): a plain JS object
      // (even one this shallow) crosses into Lua as a `js_proxy` userdata,
      // not a genuine table. `status`/`body` are both scalars, so instead
      // of proxying the whole response object, resolve with a
      // `LuaMultiReturn` — `:await()` recognizes that and expands it into
      // TWO separate Lua return values (see `wasmoon`'s promise
      // `await`/`MultiReturn` handling) — and let the trusted prelude below
      // rebuild a real `{status=..., body=...}` table out of ordinary Lua
      // table-constructor syntax.
      return LuaMultiReturn.of<string | number>(res.status, res.body);
    }) as (...args: never[]) => Promise<unknown>;
    preludeParts.push(`
local __smd_net_post = __smd_net_post_raw
__smd_net_post_raw = nil
net.post = function(url, body)
  local status, respBody = __smd_net_post(url, body):await()
  return { status = status, body = respBody }
end
`);
  } else if (
    // Mirrors the 'manual' condition above EXACTLY except for the tier, so
    // the read-only tier never exposes a wider method surface than the
    // full-grant tier would: a stub appears only where a real `net.post`
    // would have appeared under 'manual'. Without the `config.net?.post`
    // half, a host whose provider implements no POST at all would still
    // show `net.post` under 'auto' (as a tier-block stub) while showing
    // nothing under 'manual' — an inconsistency a feature-detecting script
    // (`if net.post then`) would read exactly backwards.
    config.tier === 'auto' &&
    config.net?.post &&
    netGrants.post.length > 0
  ) {
    rawGlobals.__smd_net_post_tier_blocked_raw = (async () => {
      const message =
        'net.post is granted but not permitted under the read-only auto tier (requires a manual run)';
      recordDenial('tier-blocked', message);
      throw capabilityError(message);
    }) as (...args: never[]) => Promise<unknown>;
    preludeParts.push(`
local __smd_net_post_blocked = __smd_net_post_tier_blocked_raw
__smd_net_post_tier_blocked_raw = nil
net.post = function(url, body) return __smd_net_post_blocked(url, body):await() end
`);
  }

  if (
    config.tier === 'manual' &&
    config.net?.patch &&
    netGrants.post.length > 0
  ) {
    rawGlobals.__smd_net_patch_raw = (async (url: string, body: string) => {
      const host = hostnameOf(url);
      if (!host || !netGrants.post.includes(host)) {
        const message = `net access to host "${host ?? url}" not granted for PATCH`;
        recordDenial('denied', message);
        throw capabilityError(message);
      }
      const res = await config.net!.patch!(url, body);
      // Same fix as `net.post` above (GitHub issue #6) — see that block's
      // comment for the full mechanism.
      return LuaMultiReturn.of<string | number>(res.status, res.body);
    }) as (...args: never[]) => Promise<unknown>;
    preludeParts.push(`
local __smd_net_patch = __smd_net_patch_raw
__smd_net_patch_raw = nil
net.patch = function(url, body)
  local status, respBody = __smd_net_patch(url, body):await()
  return { status = status, body = respBody }
end
`);
  } else if (
    // Same mirroring as the POST stub above — see its comment.
    config.tier === 'auto' &&
    config.net?.patch &&
    netGrants.post.length > 0
  ) {
    rawGlobals.__smd_net_patch_tier_blocked_raw = (async () => {
      const message =
        'net.patch is granted but not permitted under the read-only auto tier (requires a manual run)';
      recordDenial('tier-blocked', message);
      throw capabilityError(message);
    }) as (...args: never[]) => Promise<unknown>;
    preludeParts.push(`
local __smd_net_patch_blocked = __smd_net_patch_tier_blocked_raw
__smd_net_patch_tier_blocked_raw = nil
net.patch = function(url, body) return __smd_net_patch_blocked(url, body):await() end
`);
  }

  // --- cache --------------------------------------------------------------
  // cache.get is implemented ENTIRELY IN LUA (see the prelude below),
  // calling the script-provided `fn` as a normal Lua-to-Lua call. This is
  // deliberate, not just tidy: `fn` may itself call `net.fetch_json`
  // (which needs to `:await()`), and a Lua function invoked FROM JS
  // (rather than from Lua) goes through the same non-yieldable
  // `lua_pcallk` bridge described above — so `cache.get`'s JS side only
  // ever exposes plain read/write primitives (`__smd_cache_get_raw`,
  // `__smd_cache_set_raw`); the read-if-fresh-else-run-fn CONTROL FLOW is
  // Lua calling Lua, never JS calling Lua.
  //
  // ## The same issue #6 proxy problem, on a cache HIT
  //
  // A stored value that came from `net.fetch_json` (the canonical idiom
  // documented in `docs/scripting.md`: `cache.get(key, ttl, function()
  // return net.fetch_json(url) end)`) is exactly the JSON-shaped data
  // `./json-decode`'s doc comment already covers. Handing a cache HIT's
  // stored value back to Lua as-is has the identical fix requirement as
  // `net.fetch_json`'s own result: it must not cross the boundary as a raw
  // JS object (a `js_proxy` userdata), or `type()`/`#`/marshaling a nested
  // hit result breaks exactly like an un-fixed `fetch_json` would.
  //
  // The fix mirrors `net.fetch_json` exactly and reuses BOTH of its pieces:
  //   - On `cache.get`'s READ side, the raw JS function JSON-encodes the
  //     stored value (`JSON.stringify`, on a value that's already
  //     plain/JSON-safe — see the WRITE side below) and hands back that
  //     TEXT, a scalar with no proxy involved, alongside the plain-number
  //     `storedAtMs`, via one `LuaMultiReturn` (same technique
  //     `net.post`/`net.patch` use for their two-field response). Lua then
  //     decodes it with the SAME `__smd_json_decode` fetch_json already
  //     uses (`ensureJsonDecodePrelude`).
  //   - On the WRITE side (an internal refresh, never a public
  //     `cache.set` — see `docs/scripting.md`: `cache.get` is the only
  //     public cache API), the value `fn()` computed is run through the
  //     SAME capped, cycle-safe Lua walk (`__smd_marshal_root`,
  //     `./marshal`'s `buildMarshalPrelude`) already used to bound a
  //     script's own top-level return value, BEFORE it ever crosses to JS
  //     as a function argument. This closes a real, separate gap: passing
  //     an uncapped Lua table as a host-function argument uses wasmoon's
  //     own eager, unbounded table->JS conversion (see `./marshal`'s doc
  //     comment on why the return-value path never trusts that
  //     conversion) — without this walk, `cache.get(key, ttl, function()
  //     return hugeOrCyclicTable end)` would hit that same unbounded cost,
  //     and a cyclic value would later crash the JS-side `JSON.stringify`
  //     outright. `finalizeMarshaledValue` (the same JS-side pass the
  //     top-level return path already runs) then strips the walk's array
  //     marker and rejects a non-finite number, before the plain,
  //     JSON-safe result is handed to `config.cache!.set` — so
  //     `CacheEntry.value`'s STORAGE shape is unchanged (still whatever
  //     plain value the host's `CacheProvider` already expects; e.g. a
  //     bundle's `cache/*.json` file), and a script's own scalar values
  //     (numbers, strings, booleans) round-trip exactly as before.
  //   - Either enforcement failing raises the existing, already-classified
  //     `MARSHAL_ERROR_TAG` error (`sandbox.ts` already recognizes it as
  //     `kind: 'marshal'`) — no new error taxonomy for this path.
  if (config.cache) {
    ensureJsonDecodePrelude();
    ensureMarshalPrelude();
    rawGlobals.__smd_cache_get_raw = (async (key: string) => {
      const entry = await config.cache!.get(key);
      if (entry === undefined) return undefined;
      // Depth/node budget, checked BEFORE the stored value is ever encoded
      // to text and handed to Lua — mirrors `net.fetch_json`'s own
      // pre-check exactly (adversarial finding B2). A host-stored value is
      // exactly as untrusted as a remote fetch body — a bundle's
      // `cache/*.json` file, for instance, can be edited by anything with
      // write access to the bundle, not just this sandbox's own WRITE side
      // below — so without this check, a 300k-element cached array reached
      // the script completely uncapped even though the FETCH path was
      // already capped.
      //
      // An entry that fails the budget check, or that cannot be
      // `JSON.stringify`'d at all (cyclic, or BigInt-bearing — something
      // other than this sandbox's own WRITE side must have written it,
      // since that side already rejects both), is SELF-HEALED rather than
      // denied (orchestrator decision, #6 verification notes): it is
      // treated as a cache MISS, exactly as if `key` had never been
      // stored. `cache.get`'s Lua body (below) then calls `fn()` and
      // writes the fresh, already-capped result back through
      // `__smd_cache_set_raw`, which quietly repairs the stored entry for
      // next time. No denial is recorded for this path — a capability
      // denial is reserved for the fresh recompute itself failing the
      // WRITE side's own caps, which is unchanged.
      const budgetCheck = checkJsonWithinLimits(entry.value, marshalLimits);
      if (!budgetCheck.ok) return undefined;
      let text: string;
      try {
        const encoded = JSON.stringify(entry.value);
        text = encoded === undefined ? 'null' : encoded;
      } catch {
        return undefined;
      }
      return LuaMultiReturn.of<string | number>(text, entry.storedAtMs);
    }) as (...args: never[]) => Promise<unknown>;
    rawGlobals.__smd_cache_set_raw = (async (
      key: string,
      // Already the output of `__smd_marshal_root` (`./marshal`'s
      // `buildMarshalPrelude`) by the time it reaches here — see the
      // prelude below — so this is a bounded, cycle-free, marker-tagged
      // plain value (or a scalar), never a raw uncapped Lua table.
      marshaledValue: unknown,
      storedAtMs: number,
    ) => {
      const finalized = finalizeMarshaledValue(marshaledValue);
      if (!finalized.ok) {
        throw new Error(`${MARSHAL_ERROR_TAG}:${finalized.reason}`);
      }
      await config.cache!.set(key, { value: finalized.value, storedAtMs });
      return true;
    }) as (...args: never[]) => Promise<unknown>;
    // `now` (for TTL freshness) is computed in JS, once per cache.get
    // call, and handed to Lua as a plain number argument — there is no
    // `os.time()` in this sandbox (§10: no `os` library at all), so the
    // clock is a host-provided value, not a Lua-reachable ambient
    // capability.
    rawGlobals.__smd_now_ms_raw = (async () => Date.now()) as (
      ...args: never[]
    ) => Promise<unknown>;

    preludeParts.push(`
local __smd_cache_get = __smd_cache_get_raw
local __smd_cache_set = __smd_cache_set_raw
local __smd_now_ms = __smd_now_ms_raw
-- Captured into locals HERE, at prelude-definition time -- NOT resolved as
-- dynamic globals inside cache.get's own body (adversarial findings A2 and
-- D1). Without this, a script could do \`__smd_json_decode = function(t)
-- return t end\` (A2) or, more seriously, \`__smd_marshal_root = function(v)
-- return v end\` (D1) before a LATER cache.get call: the marshal-root
-- rebind would send an UNBOUNDED, uncapped table straight through
-- wasmoon's own eager table->JS conversion into the store the moment the
-- rebound "identity" function handed it back, since the write side
-- (\`__smd_cache_set_raw\` below) would then be receiving whatever the
-- script substituted with no cap ever having run -- the return-value path
-- was never vulnerable to this trick only because of an unrelated
-- evaluation-order accident (its own \`__smd_marshal_root\` call happens
-- inside \`wrapUserCode\`'s generated code, evaluated before the script's
-- own top-level statements finish), not because the global was pinned.
local __smd_cache_json_decode = __smd_json_decode
local __smd_cache_marshal_root = __smd_marshal_root
__smd_cache_get_raw = nil
__smd_cache_set_raw = nil
__smd_now_ms_raw = nil
cache = cache or {}
cache.get = function(key, ttl, fn)
  local text, storedAtMs = __smd_cache_get(key):await()
  if text ~= nil then
    local now = __smd_now_ms():await()
    if (now - storedAtMs) < (ttl * 1000) then
      return __smd_cache_json_decode(text)
    end
  end
  local value = fn()
  __smd_cache_set(key, __smd_cache_marshal_root(value), __smd_now_ms():await()):await()
  return value
end
`);
  }

  // --- bundle -------------------------------------------------------------
  // Delegates entirely to the injected `ScriptView` (`@markii/bundle`), which
  // already enforces the path-jail and the read/write:cache/ split (spec
  // §11). This module adds nothing on top except the tier gate for
  // `bundle.write` (a tier-blocked stub under 'auto' — read-only tier) and
  // the byte<->Lua-string conversion.
  if (config.bundle) {
    const view = config.bundle;
    // `ScriptView` (@markii/bundle) throws its own `ScriptCapabilityError` /
    // `BundlePathError` for a denied or path-jail-violating call — those
    // are re-tagged here with `CAPABILITY_ERROR_TAG` (a cosmetic prefix
    // only, see `./errors`'s doc comment) AND recorded on the `denials`
    // handle as reason `'denied'`, so `sandbox.ts` reports them as
    // `kind: 'capability', capability: 'denied'` uniformly, the same as a
    // net host-allowlist denial, rather than falling through to the
    // generic `'runtime'` bucket.
    rawGlobals.__smd_bundle_read_raw = (async (path: string) => {
      let data: Uint8Array | undefined;
      try {
        data = await view.read(path);
      } catch (err) {
        const message = describeThrown(err);
        recordDenial('denied', message);
        throw capabilityError(message);
      }
      return data === undefined ? null : bytesToLuaString(data);
    }) as (...args: never[]) => Promise<unknown>;
    rawGlobals.__smd_bundle_exists_raw = (async (path: string) => {
      try {
        return await view.exists(path);
      } catch (err) {
        const message = describeThrown(err);
        recordDenial('denied', message);
        throw capabilityError(message);
      }
    }) as (...args: never[]) => Promise<unknown>;

    preludeParts.push(`
local __smd_bundle_read = __smd_bundle_read_raw
local __smd_bundle_exists = __smd_bundle_exists_raw
__smd_bundle_read_raw = nil
__smd_bundle_exists_raw = nil
bundle = bundle or {}
bundle.read = function(path) return __smd_bundle_read(path):await() end
bundle.exists = function(path) return __smd_bundle_exists(path):await() end
`);

    if (config.tier === 'manual') {
      rawGlobals.__smd_bundle_write_raw = (async (
        path: string,
        data: string,
      ) => {
        try {
          await view.write(path, luaStringToBytes(data));
        } catch (err) {
          const message = describeThrown(err);
          recordDenial('denied', message);
          throw capabilityError(message);
        }
        return true;
      }) as (...args: never[]) => Promise<unknown>;
      preludeParts.push(`
local __smd_bundle_write = __smd_bundle_write_raw
__smd_bundle_write_raw = nil
bundle.write = function(path, data) return __smd_bundle_write(path, data):await() end
`);
    } else {
      // Under 'auto': `bundle.write` is wired to a TIER-BLOCKED STUB that
      // records a 'tier-blocked' denial and throws WITHOUT EVER reaching
      // `view.write` — the bundle view's own write path is never touched,
      // so this grants nothing new; it only makes "write is available but
      // this tier forbids it" classifiable instead of collapsing into an
      // ordinary "attempt to call a nil value" runtime error (spec §8:
      // "bundle/cache reads, cache writes only" under the read-only tier).
      rawGlobals.__smd_bundle_write_tier_blocked_raw = (async () => {
        const message =
          'bundle.write is not permitted under the read-only auto tier (requires a manual run)';
        recordDenial('tier-blocked', message);
        throw capabilityError(message);
      }) as (...args: never[]) => Promise<unknown>;
      preludeParts.push(`
local __smd_bundle_write_blocked = __smd_bundle_write_tier_blocked_raw
__smd_bundle_write_tier_blocked_raw = nil
bundle.write = function(path, data) return __smd_bundle_write_blocked(path, data):await() end
`);
    }
  }

  return { rawGlobals, preludeLua: preludeParts.join('\n'), denials };
}
