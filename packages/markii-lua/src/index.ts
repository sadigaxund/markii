// @markii/lua: the sandboxed Lua 5.4 (wasmoon) execution primitive backing
// spec §8 (scripting), §10 (capability security), and §11 (bundle-scoped
// filesystem). No React, no @markii/core, no @markii/react — see AGENTS.md's
// import rule and the ESLint guard in the root config. May depend on
// @markii/bundle for the `ScriptView` capability type only.

export type {
  ScriptFailure,
  ScriptLimitKind,
  ScriptMarshalReason,
} from './errors.js';
export {
  CAPABILITY_ERROR_TAG,
  FETCH_DECODE_ERROR_TAG,
  MARSHAL_ERROR_TAG,
  ScriptLimitError,
} from './errors.js';

export type { CreateEmptyLuaEngineOptions } from './globals.js';
export {
  ALLOWED_GLOBALS,
  DENIED_GLOBALS,
  createEmptyLuaEngine,
} from './globals.js';

export type { LimitHandle, ScriptLimits } from './limits.js';
export { DEFAULT_LIMITS, installLimits } from './limits.js';

export type {
  CacheEntry,
  CacheProvider,
  CapabilityConfig,
  CapabilityDenial,
  CapabilityDenials,
  CapabilityTier,
  NetGrants,
  NetProvider,
  NetResponse,
} from './capabilities.js';
export {
  DEFAULT_MAX_FETCH_BYTES,
  bytesToLuaString,
  buildCapabilities,
  luaStringToBytes,
} from './capabilities.js';

export type { MarshalLimits } from './marshal.js';
export {
  DEFAULT_MARSHAL_LIMITS,
  buildMarshalPrelude,
  checkJsonWithinLimits,
  finalizeMarshaledValue,
  wrapUserCode,
} from './marshal.js';

export { NOT_YET_SUPPORTED_MESSAGE, buildRequireStub } from './require.js';

export type { RunScriptOptions, RunScriptResult } from './sandbox.js';
export { runScript } from './sandbox.js';

export type { LuaExecutorConfig } from './executor.js';
export { createLuaExecutor } from './executor.js';
