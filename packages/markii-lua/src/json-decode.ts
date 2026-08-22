import { FETCH_DECODE_ERROR_TAG } from './errors.js';
import { ARRAY_MARKER, type MarshalLimits } from './marshal.js';

/**
 * Builds the trusted Lua prelude defining `__smd_json_decode(text)`, the
 * fix for GitHub issue #6: `net.fetch_json` used to hand the script
 * wasmoon's own JS→Lua conversion of the parsed JSON object, which for any
 * non-scalar JS value is a live PROXY (userdata wrapping the JS object via
 * wasmoon's `js_proxy` metatable), never a genuine Lua table. That is the
 * single root cause of all three traps the issue describes:
 *
 *   1. Returning any nested piece of the result fails marshaling with
 *      `MARK_MARSHAL:type:userdata` — `./marshal`'s in-Lua walk sees
 *      `type(value) == "userdata"` for the proxy and rejects it outright
 *      (functions/userdata/threads are never marshalable, by design).
 *   2. `type()` on the proxy genuinely returns `"userdata"` (it IS a
 *      wasmoon `js_proxy` userdata, metatable-dressed to answer to
 *      indexing like a table) and `#`/`pairs()` only work through that
 *      metatable's `__len`/`__pairs`, which use 0-based JS semantics
 *      inconsistent with the proxy's own 1-based `__index` — forcing a
 *      script to guard every operation on the result with `pcall`.
 *   3. Reading a field whose JSON value is `null` raises instead of
 *      returning `nil`: the proxy's `__index` returns the raw JS `null`,
 *      and wasmoon has no type extension that can push a bare JS `null`
 *      onto the Lua stack (verified against `wasmoon`'s `NullTypeExtension`,
 *      which is only registered when the engine option `injectObjects` is
 *      on — it never is in this sandbox, see `./globals`), so the push
 *      throws.
 *
 * Rather than fighting wasmoon's proxy machinery from the JS side (there is
 * no supported way to make a plain JS object push as a genuine, non-proxied
 * Lua table — only Lua's own table-constructor syntax produces one), this
 * decodes the fetched body ENTIRELY IN LUA, the same philosophy `./marshal`
 * already uses for the opposite direction (see that module's doc comment on
 * why wasmoon's automatic conversions aren't trusted for anything
 * resource-shaped): `./capabilities`' `net.fetch_json` hands this function
 * the raw JSON text (a plain Lua string — strings are scalars, so they
 * cross the JS↔Lua boundary cleanly with no proxy involved) and gets back a
 * genuine Lua table built entirely out of ordinary `{}`/`t[k]=v` operations,
 * indistinguishable from a table the script constructed itself: `type()`
 * says `"table"`, `#`/`ipairs`/`pairs` behave normally, and a JSON `null`
 * (as an OBJECT value) simply never gets assigned a key — reading it back
 * is an ordinary, un-raising Lua `nil`. `cache.get`'s hit path (`./capabilities`)
 * reuses this exact function for the identical reason: a cache hit re-enters
 * Lua the same way a fetch result does.
 *
 * ## Depth/size caps: enforced BEFORE this ever runs, not by this function
 *
 * `./capabilities`' `net.fetch_json` and `cache.get` both call `./marshal`'s
 * `checkJsonWithinLimits` on the already-`JSON.parse`d body/stored value and
 * reject an oversized/too-deep one as an ordinary capability denial
 * (recorded on the same `CapabilityDenials` handle the byte-size cap already
 * uses) BEFORE the raw text is ever handed to this decoder. This function's
 * own `maxDepth` check exists only as a recursion-depth (Lua C-stack) safety
 * net for the case where that pre-check and this decoder's walk of the
 * EXACT SAME text would ever disagree — see `FETCH_DECODE_ERROR_TAG`'s doc
 * comment. There is no matching node-count check here: an instruction
 * count over the sandbox's existing hook (`./limits`) already bounds the
 * cost of a pathological decode the same way it bounds any other
 * expensive Lua loop, so a second, independently-tuned node counter would
 * only duplicate that enforcement.
 *
 * ## Why re-parse instead of reusing `JSON.parse`'s result
 *
 * `./capabilities` already calls `JSON.parse` once, to produce a clear
 * "not valid JSON" error message and to run the depth/size pre-check
 * above. Re-parsing the SAME (already-validated) text here in Lua is
 * intentionally redundant: it is the only way to build genuine Lua tables
 * at all (see above), and the cost is bounded by the same `maxFetchBytes`
 * cap that already bounds the JS-side parse.
 *
 * ## Every Lua primitive this decoder uses is pinned at PRELUDE-DEFINITION
 * ## time, not resolved as a dynamic global at call time (adversarial
 * ## finding A1)
 *
 * `string.byte`/`sub`/`find`/`char`, `table.concat`, `tonumber`,
 * `math.floor`, and `error` are all captured into locals ONCE, at the top
 * of this chunk — which runs immediately when this prelude is injected,
 * before any untrusted script code ever runs — and every nested function
 * below closes over those locals as upvalues. Without this (the ORIGINAL
 * shape of this file resolved them as plain global lookups INSIDE
 * `__smd_json_decode`, i.e. at every CALL, not just once), a script could
 * do `error = function() end` (or `string = {}`) before a LATER
 * `net.fetch_json`/`cache.get` call and silently disable this decoder's own
 * safety checks (verified empirically: rebinding `error` this way disables
 * the depth guard entirely, since `fail()` would then no longer actually
 * raise). This mirrors `./marshal`'s own `buildMarshalPrelude`, which
 * already does exactly this for the same reason (see that module's doc
 * comment referencing sandbox-audit finding F-1).
 */
export function buildJsonDecodePrelude(limits: MarshalLimits): string {
  return `
local __smd_jd_error, __smd_jd_tonumber, __smd_jd_floor =
  error, tonumber, math.floor
local __smd_jd_sbyte, __smd_jd_ssub, __smd_jd_sfind, __smd_jd_schar =
  string.byte, string.sub, string.find, string.char
local __smd_jd_tconcat = table.concat

function __smd_json_decode(__smd_json_text)
  local error, tonumber, floor = __smd_jd_error, __smd_jd_tonumber, __smd_jd_floor
  local sbyte, ssub, sfind, schar = __smd_jd_sbyte, __smd_jd_ssub, __smd_jd_sfind, __smd_jd_schar
  local tconcat = __smd_jd_tconcat

  local text = __smd_json_text
  local len = #text
  local pos = 1
  local maxDepth = ${limits.maxDepth}

  local function fail(reason)
    error("${FETCH_DECODE_ERROR_TAG}:" .. reason)
  end

  local function skip_ws()
    while pos <= len do
      local c = sbyte(text, pos)
      if c == 32 or c == 9 or c == 10 or c == 13 then
        pos = pos + 1
      else
        return
      end
    end
  end

  -- Encodes one Unicode code point as UTF-8 bytes, for \\uXXXX escapes
  -- inside JSON strings. No \`utf8\` library is loaded in this sandbox (see
  -- \`./globals\`), so this is a small hand-rolled encoder covering the full
  -- Unicode range JSON can express (a lone \\uXXXX escape, or a surrogate
  -- pair for a codepoint above the Basic Multilingual Plane).
  local function utf8_encode(cp)
    if cp <= 0x7F then
      return schar(cp)
    elseif cp <= 0x7FF then
      return schar(0xC0 + floor(cp / 0x40), 0x80 + (cp % 0x40))
    elseif cp <= 0xFFFF then
      return schar(
        0xE0 + floor(cp / 0x1000),
        0x80 + (floor(cp / 0x40) % 0x40),
        0x80 + (cp % 0x40)
      )
    else
      return schar(
        0xF0 + floor(cp / 0x40000),
        0x80 + (floor(cp / 0x1000) % 0x40),
        0x80 + (floor(cp / 0x40) % 0x40),
        0x80 + (cp % 0x40)
      )
    end
  end

  local decode_value

  local function decode_string()
    -- text:sub(pos, pos) == '"' on entry
    pos = pos + 1
    local parts = {}
    local start = pos
    while true do
      if pos > len then fail("malformed") end
      local c = sbyte(text, pos)
      if c == 34 then -- '"'
        parts[#parts + 1] = ssub(text, start, pos - 1)
        pos = pos + 1
        return tconcat(parts)
      elseif c == 92 then -- '\\\\'
        parts[#parts + 1] = ssub(text, start, pos - 1)
        local e = ssub(text, pos + 1, pos + 1)
        if e == '"' or e == '\\\\' or e == '/' then
          parts[#parts + 1] = e
          pos = pos + 2
        elseif e == 'b' then
          parts[#parts + 1] = schar(8)
          pos = pos + 2
        elseif e == 'f' then
          parts[#parts + 1] = schar(12)
          pos = pos + 2
        elseif e == 'n' then
          parts[#parts + 1] = schar(10)
          pos = pos + 2
        elseif e == 'r' then
          parts[#parts + 1] = schar(13)
          pos = pos + 2
        elseif e == 't' then
          parts[#parts + 1] = schar(9)
          pos = pos + 2
        elseif e == 'u' then
          local hex = ssub(text, pos + 2, pos + 5)
          local code = tonumber(hex, 16)
          if not code then fail("malformed") end
          pos = pos + 6
          if code >= 0xD800 and code <= 0xDBFF
              and ssub(text, pos, pos + 1) == "\\\\u" then
            local hex2 = ssub(text, pos + 2, pos + 5)
            local low = tonumber(hex2, 16)
            if low and low >= 0xDC00 and low <= 0xDFFF then
              code = 0x10000 + (code - 0xD800) * 0x400 + (low - 0xDC00)
              pos = pos + 6
            end
          end
          parts[#parts + 1] = utf8_encode(code)
        else
          fail("malformed")
        end
        start = pos
      else
        pos = pos + 1
      end
    end
  end

  local function decode_number()
    local s, e = sfind(text, "^-?%d+%.?%d*[eE]?[%+%-]?%d*", pos)
    if not s then fail("malformed") end
    local numText = ssub(text, s, e)
    pos = e + 1
    local n = tonumber(numText)
    if not n then fail("malformed") end
    return n
  end

  local function decode_object(depth)
    if depth >= maxDepth then fail("depth") end
    pos = pos + 1 -- skip '{'
    local out = {}
    skip_ws()
    if pos <= len and sbyte(text, pos) == 125 then -- '}'
      pos = pos + 1
      return out
    end
    while true do
      skip_ws()
      if sbyte(text, pos) ~= 34 then fail("malformed") end
      local key = decode_string()
      skip_ws()
      if sbyte(text, pos) ~= 58 then fail("malformed") end -- ':'
      pos = pos + 1
      local value = decode_value(depth + 1)
      -- JSON null becomes an ABSENT key, not an assigned nil -- reading it
      -- back from Lua is then an ordinary, un-raising nil (issue #6, trap 3).
      --
      -- A key EXACTLY equal to the trusted marshal walk's array marker
      -- (\`./marshal\`'s \`ARRAY_MARKER\`) is dropped, never stored -- this is
      -- attacker-controlled JSON (a remote fetch body, or a host-stored
      -- cache value), and \`finalizeMarshaledValue\` (\`./marshal\`) treats
      -- that exact key as a trusted signal that ITS OWN marshal walk
      -- produced this table and it should be reshaped into a JS array.
      -- Without dropping it here, a response body such as
      -- \`{"${ARRAY_MARKER}":true,"1":"a","2":"b","x":"kept"}\` would decode
      -- to a Lua table carrying that same key, and later marshal to the
      -- host as a JS ARRAY -- silently reshaping attacker-controlled data
      -- and dropping its real keys (adversarial finding A4). Dropping
      -- (rather than rejecting the whole response) keeps an otherwise
      -- ordinary API response usable even if it happens to use this exact
      -- field name for something unrelated.
      if value ~= nil and key ~= "${ARRAY_MARKER}" then
        out[key] = value
      end
      skip_ws()
      local c = sbyte(text, pos)
      if c == 44 then -- ','
        pos = pos + 1
      elseif c == 125 then -- '}'
        pos = pos + 1
        break
      else
        fail("malformed")
      end
    end
    return out
  end

  local function decode_array(depth)
    if depth >= maxDepth then fail("depth") end
    pos = pos + 1 -- skip '['
    local out = {}
    local n = 0
    skip_ws()
    if pos <= len and sbyte(text, pos) == 93 then -- ']'
      pos = pos + 1
      return out
    end
    while true do
      local value = decode_value(depth + 1)
      n = n + 1
      -- A JSON null ARRAY ELEMENT decodes to Lua \`false\`, not an absent
      -- slot (orchestrator decision, adversarial finding C2): an absent
      -- slot would leave a hole (\`#\`/\`ipairs\` stop early, and returning
      -- the table to the host fails \`MARK_MARSHAL:key-type\` since the walk
      -- no longer sees sequential \`1..n\` keys) -- reproducing issue #6's
      -- headline crash for any API that puts \`null\` inside an array. \`nil\`
      -- stays the right encoding for a JSON null OBJECT VALUE (an absent
      -- key, see \`decode_object\` above) because a Lua table simply has no
      -- way to represent "key present, value nil" at all; an array
      -- POSITION has no such ambiguity to preserve, so \`false\` -- itself a
      -- valid, falsy, round-trippable Lua/JSON value -- is used instead.
      if value == nil then
        out[n] = false
      else
        out[n] = value
      end
      skip_ws()
      local c = sbyte(text, pos)
      if c == 44 then
        pos = pos + 1
      elseif c == 93 then
        pos = pos + 1
        break
      else
        fail("malformed")
      end
    end
    return out
  end

  decode_value = function(depth)
    skip_ws()
    if pos > len then fail("malformed") end
    local c = sbyte(text, pos)
    if c == 34 then
      return decode_string()
    elseif c == 123 then
      return decode_object(depth)
    elseif c == 91 then
      return decode_array(depth)
    elseif c == 116 then -- 't'rue
      if ssub(text, pos, pos + 3) == "true" then
        pos = pos + 4
        return true
      end
      fail("malformed")
    elseif c == 102 then -- 'f'alse
      if ssub(text, pos, pos + 4) == "false" then
        pos = pos + 5
        return false
      end
      fail("malformed")
    elseif c == 110 then -- 'n'ull
      if ssub(text, pos, pos + 3) == "null" then
        pos = pos + 4
        return nil
      end
      fail("malformed")
    elseif c == 45 or (c >= 48 and c <= 57) then
      return decode_number()
    else
      fail("malformed")
    end
  end

  local result = decode_value(0)
  skip_ws()
  if pos <= len then fail("malformed") end
  return result
end
`;
}
