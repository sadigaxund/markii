/**
 * The host (extension host, `preview-panel.ts`) <-> webview (`webview/
 * preview.tsx`) message contract. The host pushes a full document `update`
 * or a script-run `values` result; the webview only ever announces it is
 * ready to receive one — so the type guards below are the entire
 * wire-format validation this extension needs.
 *
 * Both guards take `unknown` and never throw: a message arriving via
 * `postMessage`/`onDidReceiveMessage` is attacker- or bug-reachable in
 * either direction (a compromised/misbehaving webview on one side, a stale
 * or malformed message on the other), so nothing here may assume shape.
 * Every field is read via `Object.prototype.hasOwnProperty.call` before use
 * — the same null-proto/hasOwn discipline `@markii/runtime`'s
 * `createValueStore` (`packages/markii-runtime/src/store.ts`) applies to
 * script-provided names — so an object that only *inherits* a `type`
 * property from its prototype chain (rather than owning one) is correctly
 * rejected instead of silently resolving through the prototype.
 */
import {
  FAILURE_KINDS,
  type FailureKind,
  type ValueStatus,
} from '@markii/runtime';

/** Host -> webview: the current document text at `revision`. */
export interface UpdateMessage {
  readonly type: 'update';
  readonly revision: number;
  readonly text: string;
  /**
   * Absolute webview URI of the FOLDER the previewed document lives in,
   * with a trailing `/` (`webview.asWebviewUri` of the document's parent
   * directory) — what the webview resolves document-relative image sources
   * against, so `:::figure{src="nice.png"}` finds the file sitting next to
   * the note. Omitted for a document that has no folder (an unsaved
   * `untitled:` buffer), in which case the webview simply leaves relative
   * sources alone; absolute `https://` images never depend on it.
   */
  readonly baseUri?: string;
}

/**
 * One value-store entry as it crosses the wire — structurally the same
 * shape as `@markii/runtime`'s `StoredValue`, restated here rather than
 * imported so this file's own hostile-shape guard owns the validation
 * (mirroring `StoredValue`'s fields keeps `createValueStore(message.values)`
 * a direct, no-conversion call on the webview side — see `webview/
 * preview.tsx`).
 */
export interface WireStoredValue {
  readonly value: unknown;
  readonly status: ValueStatus;
  readonly error?: string;
  readonly failureKind?: FailureKind;
  readonly ranAt?: number;
}

/** One script's outcome, reduced to just its name and failure kind — never the raw error message (the rendered page shows quiet markers, never error dumps; see AGENTS.md's cleanliness principle). */
export interface ValuesFailure {
  readonly name: string;
  readonly kind: FailureKind;
}

/**
 * Host -> webview: the outcome of a manual `markii.runScripts` run at
 * `revision` — the value store's contents plus which named scripts failed
 * and how. `revision` is the text revision the run was actually performed
 * against (captured at Run time), NOT necessarily the webview's most recent
 * `update` — a run started against an older revision, if the document kept
 * changing while it ran, still reports the revision it ran against so the
 * webview can recognize and drop a now-stale result (see `isNewerRevision`'s
 * sibling `isNewerRevision`-adjacent check the webview does on receipt).
 */
export interface ValuesMessage {
  readonly type: 'values';
  readonly revision: number;
  readonly values: Readonly<Record<string, WireStoredValue>>;
  readonly failures: readonly ValuesFailure[];
}

/** Webview -> host: the webview's message listener has attached and it is ready to receive the first `update`. */
export interface ReadyMessage {
  readonly type: 'ready';
}

export type HostToWebviewMessage = UpdateMessage | ValuesMessage;
export type WebviewToHostMessage = ReadyMessage;

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** True for a non-null, non-array object — the only shape either message type can ever be. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A valid `revision`: a finite, non-negative integer. Rejects `NaN`, `±Infinity`, negative numbers, and non-integers. */
function isValidRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Schemes a `baseUri` may carry. `vscode.Webview.asWebviewUri` returns an
 * `https:` URL on current VS Code desktop and web builds
 * (`https://file+.vscode-resource.vscode-cdn.net/...`) and the older
 * `vscode-resource:`/`vscode-webview-resource:` forms on older or
 * differently-hosted builds, so all of those are accepted — while
 * `javascript:`, `data:`, `blob:` and everything else are not. The webview
 * feeds this value to `new URL(src, baseUri)`, so an attacker-chosen scheme
 * here would become the scheme of every relative image in the document.
 */
const BASE_URI_SCHEMES: ReadonlySet<string> = new Set([
  'https:',
  'http:',
  'vscode-resource:',
  'vscode-webview-resource:',
  'vscode-file:',
]);

/**
 * A sane upper bound on a base URI. Real ones are a file-system path plus a
 * host (well under a kilobyte); the cap exists so a hostile multi-megabyte
 * string can never be parsed, stored via `setState`, or prefixed onto every
 * image URL in a document.
 */
const MAX_BASE_URI_LENGTH = 4096;

/**
 * True for a base URI this extension is willing to resolve relative image
 * sources against: a bounded, absolute, parseable URL whose scheme is in
 * `BASE_URI_SCHEMES`. Everything else — a non-string, an empty string, a
 * relative URL, `javascript:alert(1)`, a `data:` payload, a giant string —
 * is rejected.
 *
 * Exported because the webview's persisted state (`webview/vscode-api.ts`)
 * carries a base URI too and must apply the exact same check to it rather
 * than trusting whatever `getState()` hands back.
 */
export function isSafeBaseUri(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_BASE_URI_LENGTH) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return BASE_URI_SCHEMES.has(parsed.protocol);
}

function isUpdateMessage(value: unknown): value is UpdateMessage {
  if (!isPlainObject(value)) return false;
  if (!hasOwn(value, 'type') || value.type !== 'update') return false;
  if (!hasOwn(value, 'revision') || !isValidRevision(value.revision)) {
    return false;
  }
  if (!hasOwn(value, 'text') || typeof value.text !== 'string') return false;
  // `baseUri` is optional — a document with no folder omits it entirely, and
  // an own property explicitly set to `undefined` (which `postMessage`'s
  // structured clone preserves) counts as omitted. Present-and-anything-else
  // rejects the WHOLE message rather than dropping just the field: a message
  // carrying a hostile base is a hostile message, and the previous revision
  // stays on screen, which is the quiet degradation the cleanliness
  // principle asks for.
  if (
    hasOwn(value, 'baseUri') &&
    value.baseUri !== undefined &&
    !isSafeBaseUri(value.baseUri)
  ) {
    return false;
  }
  return true;
}

/** A valid `FailureKind`: exactly one of `@markii/runtime`'s closed `FAILURE_KINDS`, never a forged/renamed/stale string. */
function isValidFailureKind(value: unknown): value is FailureKind {
  return (
    typeof value === 'string' &&
    (FAILURE_KINDS as readonly string[]).includes(value)
  );
}

/** A valid `ValueStatus`: exactly one of `@markii/runtime`'s closed `StoredValue.status` values. */
function isValidValueStatus(value: unknown): value is ValueStatus {
  return (
    value === 'fresh' ||
    value === 'stale' ||
    value === 'error' ||
    value === 'missing'
  );
}

function isWireStoredValue(value: unknown): value is WireStoredValue {
  if (!isPlainObject(value)) return false;
  // `value` (the stored payload itself) may legitimately BE `undefined` —
  // what matters is that the property is OWNED, not inherited, same
  // discipline as every other field here.
  if (!hasOwn(value, 'value')) return false;
  if (!hasOwn(value, 'status') || !isValidValueStatus(value.status)) {
    return false;
  }
  if (
    hasOwn(value, 'error') &&
    value.error !== undefined &&
    typeof value.error !== 'string'
  ) {
    return false;
  }
  if (
    hasOwn(value, 'failureKind') &&
    value.failureKind !== undefined &&
    !isValidFailureKind(value.failureKind)
  ) {
    return false;
  }
  if (
    hasOwn(value, 'ranAt') &&
    value.ranAt !== undefined &&
    (typeof value.ranAt !== 'number' || !Number.isFinite(value.ranAt))
  ) {
    return false;
  }
  return true;
}

/** Every OWN entry of `value` is a valid `WireStoredValue` — `Object.keys` already only enumerates own enumerable properties, so an entry inherited from a prototype is never visited (and therefore never trusted) here. */
function isWireStoredValueRecord(
  value: unknown,
): value is Record<string, WireStoredValue> {
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (!isWireStoredValue(value[key])) return false;
  }
  return true;
}

function isValuesFailure(value: unknown): value is ValuesFailure {
  if (!isPlainObject(value)) return false;
  if (!hasOwn(value, 'name') || typeof value.name !== 'string') return false;
  if (!hasOwn(value, 'kind') || !isValidFailureKind(value.kind)) return false;
  return true;
}

function isValuesFailureArray(value: unknown): value is ValuesFailure[] {
  return Array.isArray(value) && value.every(isValuesFailure);
}

function isValuesMessage(value: unknown): value is ValuesMessage {
  if (!isPlainObject(value)) return false;
  if (!hasOwn(value, 'type') || value.type !== 'values') return false;
  if (!hasOwn(value, 'revision') || !isValidRevision(value.revision)) {
    return false;
  }
  if (!hasOwn(value, 'values') || !isWireStoredValueRecord(value.values)) {
    return false;
  }
  if (!hasOwn(value, 'failures') || !isValuesFailureArray(value.failures)) {
    return false;
  }
  return true;
}

export function isHostToWebviewMessage(
  value: unknown,
): value is HostToWebviewMessage {
  return isUpdateMessage(value) || isValuesMessage(value);
}

export function isWebviewToHostMessage(
  value: unknown,
): value is WebviewToHostMessage {
  if (!isPlainObject(value)) return false;
  if (!hasOwn(value, 'type') || value.type !== 'ready') return false;
  return true;
}

/**
 * True when `incoming` is a newer revision than `lastSeen` — a strict `>`
 * comparison, so a repeated or out-of-order delivery of the same or an
 * older revision is never applied. Both arguments must be finite integers;
 * anything else (a caller passing `NaN`/`Infinity`/a non-integer through)
 * returns `false` rather than throwing or comparing nonsensically.
 */
export function isNewerRevision(lastSeen: number, incoming: number): boolean {
  if (!Number.isInteger(lastSeen) || !Number.isInteger(incoming)) {
    return false;
  }
  return incoming > lastSeen;
}
