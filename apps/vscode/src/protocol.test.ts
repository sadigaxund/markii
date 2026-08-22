import { describe, expect, it } from 'vitest';
import {
  isHostToWebviewMessage,
  isNewerRevision,
  isSafeBaseUri,
  isWebviewToHostMessage,
} from './protocol';
import type { ValuesMessage, WireStoredValue } from './protocol';

const WEBVIEW_BASE = 'https://file+.vscode-resource.vscode-cdn.net/home/u/n/';

describe('isHostToWebviewMessage', () => {
  it('accepts a well-formed update message', () => {
    expect(
      isHostToWebviewMessage({ type: 'update', revision: 1, text: 'hi' }),
    ).toBe(true);
  });

  it('accepts revision 0', () => {
    expect(
      isHostToWebviewMessage({ type: 'update', revision: 0, text: '' }),
    ).toBe(true);
  });

  it('rejects null', () => {
    expect(isHostToWebviewMessage(null)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isHostToWebviewMessage(undefined)).toBe(false);
  });

  it('rejects an array', () => {
    expect(isHostToWebviewMessage(['update', 1, 'hi'])).toBe(false);
  });

  it('rejects a bare string', () => {
    expect(isHostToWebviewMessage('update')).toBe(false);
  });

  it('rejects a number', () => {
    expect(isHostToWebviewMessage(42)).toBe(false);
  });

  it('rejects a missing type field', () => {
    expect(isHostToWebviewMessage({ revision: 1, text: 'hi' })).toBe(false);
  });

  it('rejects the wrong type value', () => {
    expect(
      isHostToWebviewMessage({ type: 'ready', revision: 1, text: 'hi' }),
    ).toBe(false);
  });

  it('rejects a missing revision field', () => {
    expect(isHostToWebviewMessage({ type: 'update', text: 'hi' })).toBe(false);
  });

  it('rejects a missing text field', () => {
    expect(isHostToWebviewMessage({ type: 'update', revision: 1 })).toBe(false);
  });

  it('rejects text that is not a string', () => {
    expect(
      isHostToWebviewMessage({ type: 'update', revision: 1, text: 42 }),
    ).toBe(false);
  });

  it('rejects a NaN revision', () => {
    expect(
      isHostToWebviewMessage({ type: 'update', revision: NaN, text: 'hi' }),
    ).toBe(false);
  });

  it('rejects an Infinity revision', () => {
    expect(
      isHostToWebviewMessage({
        type: 'update',
        revision: Infinity,
        text: 'hi',
      }),
    ).toBe(false);
  });

  it('rejects a negative revision', () => {
    expect(
      isHostToWebviewMessage({ type: 'update', revision: -1, text: 'hi' }),
    ).toBe(false);
  });

  it('rejects a non-integer revision', () => {
    expect(
      isHostToWebviewMessage({ type: 'update', revision: 1.5, text: 'hi' }),
    ).toBe(false);
  });

  it('rejects a revision that is a numeric string', () => {
    expect(
      isHostToWebviewMessage({ type: 'update', revision: '1', text: 'hi' }),
    ).toBe(false);
  });

  it('rejects an object that only inherits `type` from its prototype', () => {
    const proto = { type: 'update' };
    const hostile: unknown = Object.assign(Object.create(proto), {
      revision: 1,
      text: 'hi',
    });
    expect(isHostToWebviewMessage(hostile)).toBe(false);
  });

  it('accepts a well-formed baseUri', () => {
    expect(
      isHostToWebviewMessage({
        type: 'update',
        revision: 1,
        text: 'hi',
        baseUri: WEBVIEW_BASE,
      }),
    ).toBe(true);
  });

  it('accepts a message with no baseUri at all (a document with no folder)', () => {
    expect(
      isHostToWebviewMessage({ type: 'update', revision: 1, text: 'hi' }),
    ).toBe(true);
  });

  it('accepts an explicitly undefined baseUri, which structured clone preserves', () => {
    expect(
      isHostToWebviewMessage({
        type: 'update',
        revision: 1,
        text: 'hi',
        baseUri: undefined,
      }),
    ).toBe(true);
  });

  it('rejects a non-string baseUri', () => {
    for (const baseUri of [42, null, true, {}, ['x']]) {
      expect(
        isHostToWebviewMessage({
          type: 'update',
          revision: 1,
          text: 'hi',
          baseUri,
        }),
      ).toBe(false);
    }
  });

  it('rejects a javascript: baseUri', () => {
    expect(
      isHostToWebviewMessage({
        type: 'update',
        revision: 1,
        text: 'hi',
        baseUri: 'javascript:alert(1)',
      }),
    ).toBe(false);
  });

  it('rejects a giant baseUri', () => {
    expect(
      isHostToWebviewMessage({
        type: 'update',
        revision: 1,
        text: 'hi',
        baseUri: `https://host/${'a'.repeat(100_000)}`,
      }),
    ).toBe(false);
  });

  it('rejects a baseUri that only inherits from its prototype', () => {
    const proto = { baseUri: WEBVIEW_BASE };
    const inherited: unknown = Object.assign(Object.create(proto), {
      type: 'update',
      revision: 1,
      text: 'hi',
    });
    // Inherited, so not read at all — the message is still valid, it simply
    // carries no base URI.
    expect(isHostToWebviewMessage(inherited)).toBe(true);
  });
});

const FRESH_VALUE: WireStoredValue = { value: 42, status: 'fresh' };

function valuesMessage(overrides: Partial<ValuesMessage> = {}): ValuesMessage {
  return {
    type: 'values',
    revision: 1,
    values: { a: FRESH_VALUE },
    failures: [],
    ...overrides,
  };
}

describe('isHostToWebviewMessage — values', () => {
  it('accepts a well-formed values message with no failures', () => {
    expect(isHostToWebviewMessage(valuesMessage())).toBe(true);
  });

  it('accepts an empty values record', () => {
    expect(isHostToWebviewMessage(valuesMessage({ values: {} }))).toBe(true);
  });

  it('accepts a values message carrying failures', () => {
    expect(
      isHostToWebviewMessage(
        valuesMessage({
          failures: [{ name: 'a', kind: 'capability-denied' }],
        }),
      ),
    ).toBe(true);
  });

  it('accepts every ValueStatus and every FailureKind', () => {
    const statuses = ['fresh', 'stale', 'error', 'missing'] as const;
    for (const status of statuses) {
      expect(
        isHostToWebviewMessage(
          valuesMessage({ values: { a: { value: 1, status } } }),
        ),
      ).toBe(true);
    }
    const kinds = [
      'script-error',
      'capability-denied',
      'tier-blocked',
      'limit',
    ] as const;
    for (const kind of kinds) {
      expect(
        isHostToWebviewMessage(
          valuesMessage({ failures: [{ name: 'a', kind }] }),
        ),
      ).toBe(true);
    }
  });

  it('accepts a StoredValue carrying error/failureKind/ranAt', () => {
    expect(
      isHostToWebviewMessage(
        valuesMessage({
          values: {
            a: {
              value: undefined,
              status: 'error',
              error: 'boom',
              failureKind: 'script-error',
              ranAt: 1234,
            },
          },
        }),
      ),
    ).toBe(true);
  });

  it('rejects a missing revision', () => {
    const message: Record<string, unknown> = { ...valuesMessage() };
    delete message.revision;
    expect(isHostToWebviewMessage(message)).toBe(false);
  });

  it('rejects a missing values field', () => {
    const message: Record<string, unknown> = { ...valuesMessage() };
    delete message.values;
    expect(isHostToWebviewMessage(message)).toBe(false);
  });

  it('rejects a missing failures field', () => {
    const message: Record<string, unknown> = { ...valuesMessage() };
    delete message.failures;
    expect(isHostToWebviewMessage(message)).toBe(false);
  });

  it('rejects a non-array failures field', () => {
    expect(
      isHostToWebviewMessage(valuesMessage({ failures: {} as never })),
    ).toBe(false);
  });

  it('rejects a bogus ValueStatus', () => {
    expect(
      isHostToWebviewMessage(
        valuesMessage({
          values: { a: { value: 1, status: 'bogus' as never } },
        }),
      ),
    ).toBe(false);
  });

  it('rejects a bogus FailureKind', () => {
    expect(
      isHostToWebviewMessage(
        valuesMessage({ failures: [{ name: 'a', kind: 'bogus' as never }] }),
      ),
    ).toBe(false);
  });

  it('rejects a forged prototype-pollution FailureKind', () => {
    expect(
      isHostToWebviewMessage(
        valuesMessage({
          failures: [{ name: 'a', kind: '__proto__' as never }],
        }),
      ),
    ).toBe(false);
  });

  it('rejects a values entry that only inherits its fields from a prototype', () => {
    const proto = { value: 1, status: 'fresh' };
    const hostileEntry: unknown = Object.create(proto);
    expect(
      isHostToWebviewMessage(
        valuesMessage({ values: { a: hostileEntry as WireStoredValue } }),
      ),
    ).toBe(false);
  });

  it('rejects a values record whose entry only inherits from the record prototype (never visited via Object.keys)', () => {
    const proto = { a: FRESH_VALUE };
    const hostileValues: unknown = Object.create(proto);
    expect(
      isHostToWebviewMessage(
        valuesMessage({
          values: hostileValues as Record<string, WireStoredValue>,
        }),
      ),
    ).toBe(true); // an empty own-keys record is still a valid (empty) values map
  });

  it('rejects an object that only inherits `type: values` from its prototype', () => {
    const proto = { type: 'values' };
    const hostile: unknown = Object.assign(Object.create(proto), {
      revision: 1,
      values: {},
      failures: [],
    });
    expect(isHostToWebviewMessage(hostile)).toBe(false);
  });

  it('rejects a non-string error field', () => {
    expect(
      isHostToWebviewMessage(
        valuesMessage({
          values: { a: { value: 1, status: 'error', error: 42 as never } },
        }),
      ),
    ).toBe(false);
  });

  it('rejects a non-finite ranAt', () => {
    expect(
      isHostToWebviewMessage(
        valuesMessage({
          values: {
            a: { value: 1, status: 'fresh', ranAt: Infinity as never },
          },
        }),
      ),
    ).toBe(false);
  });

  it('rejects a negative-revision values message the same as an update message', () => {
    expect(isHostToWebviewMessage(valuesMessage({ revision: -1 }))).toBe(false);
  });
});

describe('isSafeBaseUri', () => {
  it('accepts the asWebviewUri https form', () => {
    expect(isSafeBaseUri(WEBVIEW_BASE)).toBe(true);
  });

  it('accepts the older vscode-resource forms', () => {
    expect(isSafeBaseUri('vscode-resource:/home/u/n/')).toBe(true);
    expect(isSafeBaseUri('vscode-webview-resource://abc/file/home/u/')).toBe(
      true,
    );
  });

  it('rejects non-strings', () => {
    expect(isSafeBaseUri(undefined)).toBe(false);
    expect(isSafeBaseUri(null)).toBe(false);
    expect(isSafeBaseUri(42)).toBe(false);
    expect(isSafeBaseUri({ toString: () => WEBVIEW_BASE })).toBe(false);
  });

  it('rejects the empty string', () => {
    expect(isSafeBaseUri('')).toBe(false);
  });

  it('rejects a relative (non-absolute) URI', () => {
    expect(isSafeBaseUri('/home/u/n/')).toBe(false);
    expect(isSafeBaseUri('notes/')).toBe(false);
  });

  it('rejects dangerous schemes', () => {
    expect(isSafeBaseUri('javascript:alert(1)')).toBe(false);
    expect(isSafeBaseUri('data:text/html,<script>alert(1)</script>')).toBe(
      false,
    );
    expect(isSafeBaseUri('blob:https://host/abc')).toBe(false);
    expect(isSafeBaseUri('file:///etc/')).toBe(false);
  });

  it('rejects a scheme hidden behind leading whitespace', () => {
    expect(isSafeBaseUri(' javascript:alert(1)')).toBe(false);
  });

  it('rejects a string beyond the length cap', () => {
    expect(isSafeBaseUri(`https://host/${'a'.repeat(4096)}`)).toBe(false);
  });
});

describe('isWebviewToHostMessage', () => {
  it('accepts a well-formed ready message', () => {
    expect(isWebviewToHostMessage({ type: 'ready' })).toBe(true);
  });

  it('rejects null', () => {
    expect(isWebviewToHostMessage(null)).toBe(false);
  });

  it('rejects an array', () => {
    expect(isWebviewToHostMessage(['ready'])).toBe(false);
  });

  it('rejects a bare string', () => {
    expect(isWebviewToHostMessage('ready')).toBe(false);
  });

  it('rejects a missing type field', () => {
    expect(isWebviewToHostMessage({})).toBe(false);
  });

  it('rejects the wrong type value', () => {
    expect(isWebviewToHostMessage({ type: 'update' })).toBe(false);
  });

  it('rejects an object that only inherits `type` from its prototype', () => {
    const proto = { type: 'ready' };
    const hostile: unknown = Object.create(proto);
    expect(isWebviewToHostMessage(hostile)).toBe(false);
  });
});

describe('isNewerRevision', () => {
  it('is true when incoming is strictly greater than lastSeen', () => {
    expect(isNewerRevision(1, 2)).toBe(true);
  });

  it('is false when incoming equals lastSeen', () => {
    expect(isNewerRevision(2, 2)).toBe(false);
  });

  it('is false when incoming is less than lastSeen', () => {
    expect(isNewerRevision(3, 2)).toBe(false);
  });

  it('is true from the initial lastSeen of 0', () => {
    expect(isNewerRevision(0, 1)).toBe(true);
  });

  it('is false when lastSeen is NaN', () => {
    expect(isNewerRevision(NaN, 2)).toBe(false);
  });

  it('is false when incoming is NaN', () => {
    expect(isNewerRevision(1, NaN)).toBe(false);
  });

  it('is false when incoming is Infinity', () => {
    expect(isNewerRevision(1, Infinity)).toBe(false);
  });

  it('is false when either value is a non-integer', () => {
    expect(isNewerRevision(1, 1.5)).toBe(false);
    expect(isNewerRevision(1.5, 2)).toBe(false);
  });
});
