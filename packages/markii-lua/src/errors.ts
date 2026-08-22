/**
 * Typed failure taxonomy for `runScript` (see `./sandbox`). Running hostile
 * Lua must never throw a raw/opaque exception out of this package — every
 * failure mode a script can trigger (resource limits, capability denial,
 * an unmarshalable return value, or an ordinary Lua runtime error) is
 * classified into one of these kinds before it reaches the caller.
 *
 * IMPORTANT CONSTRAINT this module works around: wasmoon does not preserve
 * JS `Error` subclass identity across a round trip through the Lua VM. A
 * custom `Error` thrown from a host-provided async capability function (see
 * `./capabilities`) comes back out of `thread.run()` as a plain `Error`
 * whose `.message` is the *stringified* original error — `instanceof`
 * checks on the far side are useless (verified empirically against
 * wasmoon 1.16.0: `new MyError('x')` thrown inside an injected async
 * function round-trips as `Error: MyError: x`, not `MyError`). So
 * classification of marshal failures raised *from inside Lua execution* is
 * done by tagging the error message with `MARSHAL_ERROR_TAG` and
 * pattern-matching on it in `sandbox.ts` after the run fails (a forged
 * marshal tag only relabels one script-error-class failure as another —
 * see `classifyRuntimeError`'s doc comment).
 *
 * Capability failures are classified DIFFERENTLY, and NOT by message
 * matching (this used to be message-tag-based too — `error("MARK_CAPABILITY:
 * ...")` from a script would forge a `kind: 'capability'` result, which is
 * exactly the bug this taxonomy closes). See `./capabilities`'s
 * `CapabilityDenials` handle: every genuine denial is recorded on a plain JS
 * closure BEFORE the corresponding throw, entirely out of Lua's reach, and
 * `sandbox.ts` consults that handle — never the message that came back out
 * of the VM — to decide `kind: 'capability'`. This mirrors the discipline
 * already used for resource-limit breaches: they're tracked out-of-band via
 * a plain JS closure flag set inside the instruction hook (see `./limits`)
 * and the raw `LuaReturn.ErrorMem` C-API status code (see
 * `captureAssertOkStatus` in `./sandbox`), neither of which Lua code can see
 * or touch, so classification is exact regardless of what any error message
 * says.
 */

/**
 * Prefix tag applied to the `Error` message thrown into Lua for a capability
 * (permission) denial. PURELY COSMETIC as of the capability-denial JS-closure
 * rework (see the module doc comment above): it makes a message readable to
 * a human/log, and nothing else. It is NOT, and must never again become, a
 * classification signal — `sandbox.ts`'s `classifyRuntimeError` does not
 * (and must not) inspect it; a script forging `error("MARK_CAPABILITY:
 * ...")` produces a message containing this tag but classifies as an
 * ordinary `'runtime'`/`'script-error'` failure, exactly like any other
 * `error()` call, because no genuine denial was ever recorded on the
 * `CapabilityDenials` handle for that run.
 */
export const CAPABILITY_ERROR_TAG = 'MARK_CAPABILITY';

/** Prefix tag for a marshal-time rejection raised from the in-Lua marshal walk (see `./marshal`). */
export const MARSHAL_ERROR_TAG = 'MARK_MARSHAL';

/**
 * Prefix tag for a rejection raised from the in-Lua JSON decoder
 * (`./json-decode`'s `__smd_json_decode`, used by `net.fetch_json` — see
 * `./capabilities`). Under normal operation this never fires: the
 * depth/node budget is enforced BEFORE the fetched body ever reaches Lua
 * (`./capabilities`' `checkJsonWithinLimits` call, using the same
 * `MarshalLimits` as `./marshal`, recorded as an ordinary capability denial
 * — see `CAPABILITY_ERROR_TAG` above). The Lua-side `maxDepth` check this
 * tag backs is a pure recursion-depth (C-stack) safety net for the case
 * where that pre-check and the decoder's own walk of the exact same text
 * would ever disagree — not a second, independently-tuned limit. Like
 * `MARSHAL_ERROR_TAG`, this is NOT a classification signal `sandbox.ts`
 * inspects: a script forging this text produces an ordinary `'runtime'`
 * failure, same as any other `error()` call.
 */
export const FETCH_DECODE_ERROR_TAG = 'MARK_FETCH_DECODE';

/** The limits a run can breach; see `./limits`. */
export type ScriptLimitKind = 'instructions' | 'timeout' | 'memory';

/** Why a return value was rejected by the marshaller; see `./marshal`. */
export type ScriptMarshalReason =
  | 'depth'
  | 'nodes'
  | 'cycle'
  | 'type'
  | 'key-type'
  | 'non-finite-number'
  | 'nul-byte';

/**
 * The full discriminated failure shape `runScript` returns. `kind`:
 * - `'limit'` — a resource limit was breached (instruction count, wall
 *   clock, or memory). `limit` says which.
 * - `'capability'` — the script attempted something its granted
 *   capabilities don't allow (ungranted host, effectful op under an
 *   auto-run tier, disallowed bundle path/write). `capability` says which
 *   flavor — see below.
 * - `'marshal'` — the script's return value could not be safely converted
 *   to a JSON-serializable JS value (function/userdata/thread, a cycle,
 *   too deep, too many nodes, a non-string table key, a non-finite
 *   number, or a string containing an embedded NUL byte — wasmoon silently
 *   truncates a Lua string at its first NUL when converting to JS, so this
 *   is rejected on the Lua side before that truncation can happen).
 *   `reason` says which.
 * - `'runtime'` — an ordinary Lua error (syntax error, `error()` call,
 *   type error, stack overflow, etc.) not covered by the above.
 */
export interface ScriptFailure {
  kind: 'limit' | 'capability' | 'marshal' | 'runtime';
  message: string;
  limit?: ScriptLimitKind;
  reason?: ScriptMarshalReason;
  /**
   * Set only when `kind === 'capability'`, discriminating WHICH flavor of
   * capability failure this was — derived exclusively from `./capabilities`'
   * `CapabilityDenials` handle (a plain JS closure, never from any message
   * text; see the module doc comment):
   * - `'denied'`      — the grant was absent, or the host actively refused
   *   (an ungranted net host, a bundle path-jail rejection, a fetch-size
   *   cap). A manual run with the SAME grants would fail identically.
   * - `'tier-blocked'` — the capability genuinely exists in the granted set,
   *   but the current execution tier (`'auto'`) forbids exercising it. A
   *   manual run of the exact same script, with the exact same grants,
   *   would succeed.
   */
  capability?: 'denied' | 'tier-blocked';
}

/**
 * Thrown by the instruction-count/wall-clock hook installed in `./limits`
 * when this package needs to surface a limit breach as a JS-level
 * exception (e.g. from the outer `Promise.race` wall-clock guard in
 * `sandbox.ts`, for the async-hang case a Lua-level hook can't observe).
 * `runScript` always catches this itself — it is not part of the public
 * throwing surface, only an internal signal.
 */
export class ScriptLimitError extends Error {
  readonly limitKind: ScriptLimitKind;
  constructor(limitKind: ScriptLimitKind, message: string) {
    super(message);
    this.name = 'ScriptLimitError';
    this.limitKind = limitKind;
  }
}
