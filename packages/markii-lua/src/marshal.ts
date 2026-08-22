import type { ScriptMarshalReason } from './errors.js';
import { MARSHAL_ERROR_TAG } from './errors.js';

/** Marshal limits: caps on the shape of a script's return value. */
export interface MarshalLimits {
  /** Max table nesting depth. Default 32. */
  maxDepth: number;
  /** Max total scalar+table nodes visited. Default 20,000. */
  maxNodes: number;
}

export const DEFAULT_MARSHAL_LIMITS: MarshalLimits = {
  maxDepth: 32,
  maxNodes: 20_000,
};

/**
 * Why marshaling is done IN LUA, before the value ever reaches wasmoon's
 * own JS conversion:
 *
 * wasmoon's table type extension (`getValue` for `LuaType.Table`) eagerly
 * and unconditionally deep-converts an ENTIRE Lua table into a JS
 * object/array the moment `thread.run()` resolves — there is no hook to
 * intercept or cap that conversion from the JS side, and no way to abort
 * it partway through. Verified empirically: a returned Lua table with
 * 1,000,000 sequential integer keys took ~12 seconds to convert on
 * ordinary hardware, fully materializing a million-element JS array before
 * our own code ever got a chance to look at it or reject it. A node-count
 * cap applied AFTER that conversion would correctly reject the value, but
 * only after already paying the full CPU/memory cost of building it — that
 * fails the "reject quickly, not hang" requirement.
 *
 * So instead: the returned value is walked and re-shaped by a small
 * trusted LUA function (defined by `MARSHAL_PRELUDE` below, injected once
 * per engine — see `sandbox.ts`) that runs INSIDE the sandboxed VM, under
 * the exact same instruction-count hook (`./limits`) as the rest of the
 * script. It counts nodes and depth as it goes and raises a Lua error the
 * INSTANT either cap is exceeded — for a 1,000,000-entry table with the
 * default 20,000-node cap, that's ~20,000 `pairs` steps, not 1,000,000,
 * and it never reaches wasmoon's JS conversion step at all. Only the
 * already-capped, already-shaped result gets handed to wasmoon's
 * `getValue`, so that conversion is now cheap by construction.
 *
 * This also gives us cycle detection for free: Lua tables can be used as
 * table KEYS (by identity), so a `seen[t] = true` map, cleared on the way
 * back out of each table (so the same table appearing twice in DIFFERENT
 * branches — not a cycle — is still allowed), detects a true cycle
 * (`t.self = t`) in native Lua before wasmoon's converter would otherwise
 * have to (wasmoon's converter also handles cycles correctly by reusing a
 * seen JS object per Lua table pointer — verified empirically it does NOT
 * hang or stack-overflow on `t.self = t` — but a cycle is still not
 * JSON-serializable, so we reject it explicitly rather than silently
 * handing the host a self-referential object).
 *
 * Array vs. object: a table is treated as an array iff its keys are
 * exactly `1..n` for some `n` (checked by counting entries during the
 * `pairs` walk and comparing against `#value`) — same "sequential integer
 * keys" rule wasmoon's own converter uses for the DISPLAY shape, applied
 * here so the pre-shaped table wasmoon receives is unambiguous. Any other
 * key type is rejected (`'key-type'`) — JSON object keys are strings only,
 * and allowing e.g. a table keyed by `true`/`false` would silently produce
 * something JSON can't represent. Two edge cases fall out of this and are
 * both intentionally rejected as `'key-type'` rather than guessed at: a
 * table mixing integer and string keys (e.g. `{1, 2, x = "y"}` — not
 * cleanly a JSON array OR object), and a sparse array with holes (e.g.
 * `{[1]=1, [3]=3}`, where Lua's `#` length operator is itself undefined at
 * the border) — both have no faithful JSON shape, so we refuse to guess
 * rather than silently drop or reorder data. An empty table `{}` has no
 * keys to disambiguate and is treated as an empty array (`[]`), matching
 * the "array unless proven otherwise" default the walk falls back to.
 *
 * Numbers: Lua 5.4's `number` type covers both what would be a JSON number
 * AND non-finite IEEE-754 doubles (`0/0`, `1/0`, `-1/0`), which Lua
 * computes and returns natively with no distinct type tag. The Lua-side
 * walk lets any number through unchanged (rejecting here would need a
 * `nan`/`huge` check reimplemented in Lua, which is redundant since we
 * already do it in JS); `finalizeMarshaledValue` below does the actual
 * NaN/Infinity check, in JS, on the final (already depth/node-capped)
 * value.
 *
 * Functions, userdata, and threads are rejected outright (`'type'`) — none
 * of the exposed stdlib or capability surface should ever hand a script a
 * live function/userdata/thread to return in the first place, but this is
 * the backstop in case one leaks through.
 */
export function buildMarshalPrelude(limits: MarshalLimits): string {
  return `
-- Captured into locals AT PRELUDE-DEFINITION TIME (this chunk is doString'd
-- once per engine, before any untrusted user code runs), so the walk below
-- closes over these as upvalues fixed to the genuine primitives -- immune to
-- a later script doing e.g. \`error = function() end\` in the shared globals
-- table before this walk runs. See finding F-1 in the sandbox audit: the
-- walk previously resolved error/type/pairs/math.floor as DYNAMIC GLOBAL
-- lookups, which a script could rebind to neuter its own caps.
local error, type, pairs, floor, sfind = error, type, pairs, math.floor, string.find

local function __smd_marshal(value, seen, depth, budget)
  local t = type(value)
  if t == "nil" or t == "boolean" or t == "string" or t == "number" then
    if t == "string" and sfind(value, "\\0", 1, true) then
      error("${MARSHAL_ERROR_TAG}:nul-byte")
    end
    budget.n = budget.n + 1
    if budget.n > budget.maxNodes then error("${MARSHAL_ERROR_TAG}:nodes") end
    return value
  elseif t == "table" then
    if depth >= budget.maxDepth then error("${MARSHAL_ERROR_TAG}:depth") end
    if seen[value] then error("${MARSHAL_ERROR_TAG}:cycle") end
    seen[value] = true
    budget.n = budget.n + 1
    if budget.n > budget.maxNodes then error("${MARSHAL_ERROR_TAG}:nodes") end
    local count = 0
    local isArray = true
    for k, _ in pairs(value) do
      count = count + 1
      if type(k) ~= "number" or k < 1 or floor(k) ~= k then
        isArray = false
      end
    end
    local out = {}
    if isArray and count == #value then
      for i = 1, count do
        out[i] = __smd_marshal(value[i], seen, depth + 1, budget)
      end
    else
      isArray = false
      for k, v in pairs(value) do
        if type(k) ~= "string" then
          error("${MARSHAL_ERROR_TAG}:key-type")
        end
        out[k] = __smd_marshal(v, seen, depth + 1, budget)
      end
    end
    seen[value] = nil
    if isArray then
      out.__smd_is_array = true
    end
    return out
  else
    error("${MARSHAL_ERROR_TAG}:type:" .. t)
  end
end

-- Deliberately NOT "local": this prelude and the wrapped user code (see
-- \`wrapUserCode\` below) are compiled as SEPARATE chunks via separate
-- \`loadString\` calls, and a Lua \`local\` never survives past the chunk
-- that declared it. \`__smd_marshal_root\` must be a global so the
-- wrapper chunk can call it. \`__smd_marshal\` itself stays local -- it is
-- only ever called from within THIS chunk (from \`__smd_marshal_root\`,
-- which closes over it as an upvalue regardless of who calls
-- \`__smd_marshal_root\` later), so it never needs to be reachable by name
-- from anywhere else.
function __smd_marshal_root(value)
  local budget = { n = 0, maxNodes = ${limits.maxNodes}, maxDepth = ${limits.maxDepth} }
  return __smd_marshal(value, {}, 0, budget)
end
`;
}

/**
 * Wraps the user's script source so its return value is piped through
 * `__smd_marshal_root` before ever leaving the Lua VM. `__smd_marshal_root`
 * must already be defined as a global in this engine (via
 * `buildMarshalPrelude`, run once per engine in `sandbox.ts`) — it isn't
 * redefined per-call, only referenced.
 *
 * The user code runs inside its own function scope (`__smd_user_chunk`) so
 * a bare top-level `return` in the script behaves exactly as it would if
 * run standalone. `__smd_marshal_root` is a genuine global (see the "NOT
 * local" note on its definition above — it has to be, to survive being
 * defined in a separate chunk from the one that calls it), so it is also
 * directly visible to the untrusted script itself, not just to this
 * wrapper — this is an accepted, deliberate trade-off: a script COULD call
 * `__smd_marshal_root(x)` itself out of curiosity, but that function is
 * pure (no side effects, no capability access, no ambient authority) and
 * its worst case is raising one of the tagged errors above, so exposing it
 * this way is harmless. Avoiding it entirely would require a much heavier
 * mechanism (a custom `_ENV` per chunk) that this phase doesn't need.
 */
export function wrapUserCode(code: string): string {
  return `local function __smd_user_chunk()\n${code}\nend\nreturn __smd_marshal_root(__smd_user_chunk())`;
}

/**
 * Depth/node budget check for a plain, already-`JSON.parse`d JS value
 * (arrays/objects/strings/numbers/booleans/`null`; never a cycle, since
 * `JSON.parse` output is always a tree). Used by `./capabilities`' `net.fetch_json`
 * to reject an oversized/too-deep fetch response BEFORE the raw JSON text
 * is ever handed to Lua for decoding (`./json-decode`) — the JS-side
 * mirror of what `buildMarshalPrelude`'s in-Lua walk does for the return
 * value going the OTHER direction. Counting rule matches that walk exactly
 * so the two budgets read as one shared limit, not two independently-tuned
 * ones: every value (leaf or container) counts as one node, and `depth`
 * increases by one for each level of array/object nesting.
 */
export function checkJsonWithinLimits(
  value: unknown,
  limits: MarshalLimits,
): { ok: true } | { ok: false; reason: 'depth' | 'nodes'; message: string } {
  let nodes = 0;

  function walk(
    v: unknown,
    depth: number,
  ): { ok: true } | { ok: false; reason: 'depth' | 'nodes'; message: string } {
    nodes++;
    if (nodes > limits.maxNodes) {
      return {
        ok: false,
        reason: 'nodes',
        message: `exceeds the ${limits.maxNodes}-node limit`,
      };
    }
    if (v !== null && typeof v === 'object') {
      if (depth >= limits.maxDepth) {
        return {
          ok: false,
          reason: 'depth',
          message: `exceeds the ${limits.maxDepth}-level depth limit`,
        };
      }
      if (Array.isArray(v)) {
        for (const item of v) {
          const r = walk(item, depth + 1);
          if (!r.ok) return r;
        }
      } else {
        for (const val of Object.values(v as Record<string, unknown>)) {
          const r = walk(val, depth + 1);
          if (!r.ok) return r;
        }
      }
    }
    return { ok: true };
  }

  return walk(value, 0);
}

/**
 * True array marker set by the Lua-side marshal walk (see
 * `buildMarshalPrelude`). Exported (not just module-private) so
 * `./json-decode`'s JSON decoder can recognize and DROP this exact key if
 * it ever appears as an object key in attacker-controlled JSON (adversarial
 * finding A4): without that, a remote response body like
 * `{"__smd_is_array":true,"1":"a","2":"b","x":"kept"}` would decode to an
 * ordinary Lua table carrying this same marker key, and `finalizeMarshaledValue`
 * below — which has no way to tell "the trusted marshal walk set this" apart
 * from "the JSON itself happened to contain a key with this exact name" —
 * would then convert it to a JS ARRAY on the way out, silently reshaping
 * attacker-controlled data and dropping the object's real keys. See
 * `./json-decode`'s decoder for where the corresponding key is dropped.
 */
export const ARRAY_MARKER = '__smd_is_array';

/**
 * Final JS-side pass over the value wasmoon already converted from the
 * Lua-side-capped table: strips the `__smd_is_array` marker (converting
 * the marked object into a real JS array, since wasmoon's own array/object
 * detection — "keys are exactly 1..n" — doesn't apply once we've added a
 * non-numeric marker key to what should read as an array) and rejects
 * non-finite numbers (`NaN`, `Infinity`, `-Infinity`).
 *
 * Judgment call on NaN/Infinity: REJECTED, not silently coerced to
 * `null`. JSON has no representation for them, and a script that computed
 * one is far more likely to have hit `0/0` or a runaway `1/(x-x)` by
 * mistake than to have intended it as a value a consuming component should
 * render — silently turning that into `null` would hide the bug. A caller
 * that wants "stale/empty" semantics for that case already gets it for
 * free: a `'marshal'` failure is a normal missing-value case per spec §8
 * ("If the value is missing or the script hasn't run, the component
 * renders its empty/stale state").
 */
export function finalizeMarshaledValue(value: unknown):
  | {
      ok: true;
      value: unknown;
    }
  | { ok: false; reason: ScriptMarshalReason; message: string } {
  const seen = new Set<object>();

  function walk(
    v: unknown,
  ):
    | { ok: true; value: unknown }
    | { ok: false; reason: ScriptMarshalReason; message: string } {
    if (v === null || v === undefined) return { ok: true, value: null };
    const t = typeof v;
    if (t === 'string' || t === 'boolean') return { ok: true, value: v };
    if (t === 'number') {
      if (!Number.isFinite(v as number)) {
        return {
          ok: false,
          reason: 'non-finite-number',
          message: `script returned a non-finite number (${String(v)})`,
        };
      }
      return { ok: true, value: v };
    }
    if (Array.isArray(v)) {
      if (seen.has(v)) {
        return {
          ok: false,
          reason: 'cycle',
          message: 'script return value contains a cycle',
        };
      }
      seen.add(v);
      const out: unknown[] = [];
      for (const item of v) {
        const r = walk(item);
        if (!r.ok) return r;
        out.push(r.value);
      }
      seen.delete(v);
      return { ok: true, value: out };
    }
    if (t === 'object') {
      const obj = v as Record<string, unknown>;
      if (seen.has(obj)) {
        return {
          ok: false,
          reason: 'cycle',
          message: 'script return value contains a cycle',
        };
      }
      seen.add(obj);
      const isArray = obj[ARRAY_MARKER] === true;
      if (isArray) {
        const keys = Object.keys(obj)
          .filter((k) => k !== ARRAY_MARKER)
          .sort((a, b) => Number(a) - Number(b));
        const out: unknown[] = [];
        for (const k of keys) {
          const r = walk(obj[k]);
          if (!r.ok) return r;
          out.push(r.value);
        }
        seen.delete(obj);
        return { ok: true, value: out };
      }
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(obj)) {
        const r = walk(val);
        if (!r.ok) return r;
        out[k] = r.value;
      }
      seen.delete(obj);
      return { ok: true, value: out };
    }
    // functions/other host objects should never reach here — the Lua-side
    // walk already rejects them before they're returned at all.
    return {
      ok: false,
      reason: 'type',
      message: `script return value contained an unsupported JS type: ${t}`,
    };
  }

  return walk(value);
}
