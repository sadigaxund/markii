import { describe, expect, it, vi } from 'vitest';
import type { GrantMemento, Thenable } from './grant-flow';
import type { RunResult, SpawnRunOptions } from './run-host';
import {
  MAX_CACHE_SNAPSHOT_BYTES,
  cacheStorageKeyFor,
  isCacheSnapshotShape,
  runOnce,
  serializeCacheSnapshotIfSmallEnough,
} from './run-flow';

function fence(name: string, body: string): string {
  return '```lua {name=' + name + '}\n' + body + '\n```\n';
}

function fakeMemento(initial: Record<string, unknown> = {}): GrantMemento {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get<T>(key: string, defaultValue?: T): T {
      return (store.has(key) ? store.get(key) : defaultValue) as T;
    },
    update(key: string, value: unknown): Thenable<void> {
      if (value === undefined) {
        store.delete(key);
      } else {
        store.set(key, value);
      }
      return Promise.resolve();
    },
  };
}

function fakeRunResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    values: { a: { value: 2, status: 'fresh' } },
    failures: [],
    cacheSnapshot: {},
    ...overrides,
  };
}

describe('runOnce', () => {
  it('runs the grant flow, spawns with the resulting allowlist, and reshapes the result', async () => {
    const memento = fakeMemento();
    const spawnRun = vi.fn((_options: SpawnRunOptions): Promise<RunResult> =>
      Promise.resolve(fakeRunResult()),
    );

    const result = await runOnce({
      documentKey: 'file:///a.mk.md',
      text: fence('a', 'return net.fetch_json("https://api.example.com/x")'),
      memento,
      promptHost: () => Promise.resolve(true),
      promptUnknownHosts: () => Promise.resolve(true),
      spawnRun,
      timeoutMs: 15000,
    });

    expect(spawnRun).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnRun.mock.calls[0]?.[0];
    expect(spawnArgs?.netAllowlist).toEqual(['api.example.com']);
    expect(spawnArgs?.timeoutMs).toBe(15000);
    expect(result.values.a?.value).toBe(2);
    expect(result.failures).toEqual([]);
  });

  it('reduces RunFailure entries to {name, kind} only -- never the raw message', async () => {
    const memento = fakeMemento();
    const spawnRun = () =>
      Promise.resolve(
        fakeRunResult({
          failures: [
            {
              name: 'a',
              message: 'some internal detail',
              kind: 'script-error',
            },
          ],
        }),
      );

    const result = await runOnce({
      documentKey: 'file:///a.mk.md',
      text: fence('a', 'return 1'),
      memento,
      promptHost: () => Promise.resolve(true),
      promptUnknownHosts: () => Promise.resolve(true),
      spawnRun,
      timeoutMs: 15000,
    });

    expect(result.failures).toEqual([{ name: 'a', kind: 'script-error' }]);
  });

  it('seeds the run from a previously persisted cache snapshot for the same document', async () => {
    const documentKey = 'file:///a.mk.md';
    const memento = fakeMemento({
      [cacheStorageKeyFor(documentKey)]: {
        k: { value: 'cached', storedAtMs: 0 },
      },
    });
    const spawnRun = vi.fn((_options: SpawnRunOptions): Promise<RunResult> =>
      Promise.resolve(fakeRunResult()),
    );

    await runOnce({
      documentKey,
      text: fence('a', 'return 1'),
      memento,
      promptHost: () => Promise.resolve(true),
      promptUnknownHosts: () => Promise.resolve(true),
      spawnRun,
      timeoutMs: 15000,
    });

    expect(spawnRun.mock.calls[0]?.[0].cacheSnapshot).toEqual({
      k: { value: 'cached', storedAtMs: 0 },
    });
  });

  it('persists the returned cache snapshot for the next run', async () => {
    const documentKey = 'file:///a.mk.md';
    const memento = fakeMemento();
    const spawnRun = () =>
      Promise.resolve(
        fakeRunResult({ cacheSnapshot: { k: { value: 'x', storedAtMs: 0 } } }),
      );

    await runOnce({
      documentKey,
      text: fence('a', 'return 1'),
      memento,
      promptHost: () => Promise.resolve(true),
      promptUnknownHosts: () => Promise.resolve(true),
      spawnRun,
      timeoutMs: 15000,
    });

    expect(memento.get(cacheStorageKeyFor(documentKey))).toEqual({
      k: { value: 'x', storedAtMs: 0 },
    });
  });

  it('drops (never partially writes) a cache snapshot over the size cap', async () => {
    const documentKey = 'file:///a.mk.md';
    const memento = fakeMemento({
      [cacheStorageKeyFor(documentKey)]: { existing: true },
    });
    const huge = {
      blob: { value: 'x'.repeat(MAX_CACHE_SNAPSHOT_BYTES + 1), storedAtMs: 0 },
    };
    const spawnRun = () =>
      Promise.resolve(fakeRunResult({ cacheSnapshot: huge }));

    await runOnce({
      documentKey,
      text: fence('a', 'return 1'),
      memento,
      promptHost: () => Promise.resolve(true),
      promptUnknownHosts: () => Promise.resolve(true),
      spawnRun,
      timeoutMs: 15000,
    });

    expect(memento.get(cacheStorageKeyFor(documentKey))).toBeUndefined();
  });

  it('a foreign/corrupt stored cache value degrades to an empty seed rather than throwing', async () => {
    const documentKey = 'file:///a.mk.md';
    const memento = fakeMemento({
      [cacheStorageKeyFor(documentKey)]: 'not-an-object',
    });
    const spawnRun = vi.fn((_options: SpawnRunOptions): Promise<RunResult> =>
      Promise.resolve(fakeRunResult()),
    );

    await runOnce({
      documentKey,
      text: fence('a', 'return 1'),
      memento,
      promptHost: () => Promise.resolve(true),
      promptUnknownHosts: () => Promise.resolve(true),
      spawnRun,
      timeoutMs: 15000,
    });

    expect(spawnRun.mock.calls[0]?.[0].cacheSnapshot).toEqual({});
  });
});

describe('isCacheSnapshotShape', () => {
  it('accepts a plain object, rejects arrays/null/primitives', () => {
    expect(isCacheSnapshotShape({})).toBe(true);
    expect(isCacheSnapshotShape([])).toBe(false);
    expect(isCacheSnapshotShape(null)).toBe(false);
    expect(isCacheSnapshotShape('x')).toBe(false);
    expect(isCacheSnapshotShape(42)).toBe(false);
  });
});

describe('serializeCacheSnapshotIfSmallEnough', () => {
  it('returns the JSON text for a small snapshot', () => {
    expect(serializeCacheSnapshotIfSmallEnough({ a: 1 })).toBe('{"a":1}');
  });

  it('returns undefined for a snapshot beyond the size cap', () => {
    const huge = { blob: 'x'.repeat(MAX_CACHE_SNAPSHOT_BYTES + 1) };
    expect(serializeCacheSnapshotIfSmallEnough(huge)).toBeUndefined();
  });

  it('returns undefined for a value JSON.stringify cannot handle', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(serializeCacheSnapshotIfSmallEnough(circular)).toBeUndefined();
  });
});
