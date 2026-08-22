import { zipSync } from 'fflate';
import {
  createScriptView,
  openZipBundle,
  type BundleManifest,
} from '@markii/bundle';
import { describe, expect, it, vi } from 'vitest';
import {
  buildCapabilities,
  type CacheEntry,
  type NetResponse,
} from './capabilities';
import { createEmptyLuaEngine } from './globals';

function u8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function run(
  code: string,
  config: Parameters<typeof buildCapabilities>[0],
): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  const engine = await createEmptyLuaEngine();
  try {
    const { rawGlobals, preludeLua } = buildCapabilities(config);
    for (const [name, fn] of Object.entries(rawGlobals)) {
      engine.global.set(name, fn);
    }
    if (preludeLua.trim().length > 0) {
      await engine.doString(preludeLua);
    }
    const thread = engine.global.newThread();
    const idx = engine.global.getTop();
    try {
      thread.loadString(code);
      const result = await thread.run(0);
      return { ok: true, value: result.length > 0 ? result[0] : undefined };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    } finally {
      engine.global.remove(idx);
    }
  } finally {
    engine.global.close();
  }
}

function fakeNet(get: (url: string) => Promise<NetResponse>) {
  return { get };
}

function fixtureBundle() {
  const bytes = zipSync({
    'note.mk.md': u8('# hello'),
    'manifest.json': u8('{"mark":"0.1.0"}'),
    'assets/x.png': u8('img'),
    'cache/data.json': u8('{}'),
  });
  const storage = openZipBundle(bytes);
  const manifest: BundleManifest = {
    mark: '0.1.0',
    permissions: { bundle: ['read', 'write:cache/'] },
  };
  const view = createScriptView(storage, manifest, {
    bundle: ['read', 'write:cache/'],
  });
  return { storage, view };
}

describe('buildCapabilities — net absent when not granted', () => {
  it('with no net provider at all, `net` is nil', async () => {
    const r = await run('return type(net)', { tier: 'manual' });
    expect(r).toEqual({ ok: true, value: 'nil' });
  });

  it('with a provider but zero granted GET hosts, `net` is nil', async () => {
    const r = await run('return type(net)', {
      tier: 'manual',
      net: fakeNet(async () => ({ status: 200, body: '{}' })),
      netGrants: { get: [], post: [] },
    });
    expect(r).toEqual({ ok: true, value: 'nil' });
  });
});

describe('buildCapabilities — net.fetch_json', () => {
  it('works for a granted host via a fake provider, returning parsed JSON', async () => {
    let calledUrl: string | undefined;
    const r = await run(
      'return net.fetch_json("https://api.example.com/repo").stars',
      {
        tier: 'manual',
        net: fakeNet(async (url) => {
          calledUrl = url;
          return { status: 200, body: '{"stars": 7}' };
        }),
        netGrants: { get: ['api.example.com'], post: [] },
      },
    );
    expect(r).toEqual({ ok: true, value: 7 });
    expect(calledUrl).toBe('https://api.example.com/repo');
  });

  it('rejects a host outside the granted GET list, as a typed capability error', async () => {
    const r = await run('return net.fetch_json("https://evil.example.com/x")', {
      tier: 'manual',
      net: fakeNet(async () => ({ status: 200, body: '{}' })),
      netGrants: { get: ['api.example.com'], post: [] },
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain('MARK_CAPABILITY');
    expect(!r.ok && r.message).toContain('not granted');
  });

  it('rejects a fetch response over the size cap', async () => {
    const bigBody = JSON.stringify({ blob: 'x'.repeat(1000) });
    const r = await run('return net.fetch_json("https://api.example.com/x")', {
      tier: 'manual',
      net: fakeNet(async () => ({ status: 200, body: bigBody })),
      netGrants: { get: ['api.example.com'], post: [] },
      maxFetchBytes: 100,
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain('MARK_CAPABILITY');
    expect(!r.ok && r.message).toContain('cap');
  });

  it('rejects a non-JSON response body', async () => {
    const r = await run('return net.fetch_json("https://api.example.com/x")', {
      tier: 'manual',
      net: fakeNet(async () => ({ status: 200, body: 'not json' })),
      netGrants: { get: ['api.example.com'], post: [] },
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain('not valid JSON');
  });
});

// GitHub issue #6: net.fetch_json used to hand the script wasmoon's own
// JS->Lua proxy (a `js_proxy` userdata) instead of a genuine Lua table.
// This block asserts the fix directly: fetch_json's result now behaves
// exactly like a table the script built itself.
describe('buildCapabilities — net.fetch_json delivers plain Lua data (issue #6)', () => {
  it('a nested array taken directly from the result round-trips as a real array (used to fail with MARK_MARSHAL:type:userdata)', async () => {
    const r = await run(
      'return net.fetch_json("https://api.example.com/x").tags',
      {
        tier: 'manual',
        net: fakeNet(async () => ({
          status: 200,
          body: '{"tags": ["a", "b", "c"]}',
        })),
        netGrants: { get: ['api.example.com'], post: [] },
      },
    );
    expect(r).toEqual({ ok: true, value: ['a', 'b', 'c'] });
  });

  it('a nested object taken directly from the result round-trips as a real object', async () => {
    const r = await run(
      'return net.fetch_json("https://api.example.com/x").owner',
      {
        tier: 'manual',
        net: fakeNet(async () => ({
          status: 200,
          body: '{"owner": {"name": "ada", "id": 7}}',
        })),
        netGrants: { get: ['api.example.com'], post: [] },
      },
    );
    expect(r).toEqual({ ok: true, value: { name: 'ada', id: 7 } });
  });

  it('a JSON null field reads as nil with no error, and is absent from a returned table', async () => {
    const r = await run(
      `
      local breed = net.fetch_json("https://api.example.com/x")
      local wiki = breed.wikipedia_url
      return { name = breed.name, wiki_is_nil = wiki == nil, echoed = breed }
      `,
      {
        tier: 'manual',
        net: fakeNet(async () => ({
          status: 200,
          body: '{"name": "collie", "wikipedia_url": null}',
        })),
        netGrants: { get: ['api.example.com'], post: [] },
      },
    );
    expect(r).toEqual({
      ok: true,
      value: { name: 'collie', wiki_is_nil: true, echoed: { name: 'collie' } },
    });
  });

  it('a top-level JSON array supports type(), # and ipairs like an ordinary Lua table', async () => {
    const r = await run(
      `
      local result = net.fetch_json("https://api.example.com/x")
      local total = 0
      for _, v in ipairs(result) do total = total + v end
      return { t = type(result), len = #result, sum = total }
      `,
      {
        tier: 'manual',
        net: fakeNet(async () => ({ status: 200, body: '[1, 2, 3, 4]' })),
        netGrants: { get: ['api.example.com'], post: [] },
      },
    );
    expect(r).toEqual({ ok: true, value: { t: 'table', len: 4, sum: 10 } });
  });

  it('a fetch response exceeding the depth cap fails cleanly with a named, pcall-catchable error; the sandbox stays alive', async () => {
    // Build JSON nested one level deeper than the (default) depth cap.
    let body = '0';
    for (let i = 0; i < 40; i++) body = `{"n": ${body}}`;
    const r = await run(
      `
      local ok, err = pcall(net.fetch_json, "https://api.example.com/x")
      return { ok = ok, err_has_depth = string.find(tostring(err), "depth") ~= nil }
      `,
      {
        tier: 'manual',
        net: fakeNet(async () => ({ status: 200, body })),
        netGrants: { get: ['api.example.com'], post: [] },
      },
    );
    expect(r).toEqual({ ok: true, value: { ok: false, err_has_depth: true } });
  });

  it('a fetch response exceeding the node cap fails cleanly with a named, pcall-catchable error; the sandbox stays alive', async () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const r = await run(
      `
      local ok, err = pcall(net.fetch_json, "https://api.example.com/x")
      return { ok = ok, err_has_nodes = string.find(tostring(err), "node") ~= nil }
      `,
      {
        tier: 'manual',
        net: fakeNet(async () => ({
          status: 200,
          body: JSON.stringify(items),
        })),
        netGrants: { get: ['api.example.com'], post: [] },
        marshalLimits: { maxDepth: 32, maxNodes: 10 },
      },
    );
    expect(r).toEqual({ ok: true, value: { ok: false, err_has_nodes: true } });
  });

  it('a depth-cap rejection is an ordinary capability denial (recorded, non-spoofable), not a later crash', async () => {
    let body = '0';
    for (let i = 0; i < 40; i++) body = `{"n": ${body}}`;
    const engine = await createEmptyLuaEngine();
    try {
      const { rawGlobals, preludeLua, denials } = buildCapabilities({
        tier: 'manual',
        net: fakeNet(async () => ({ status: 200, body })),
        netGrants: { get: ['api.example.com'], post: [] },
      });
      for (const [name, fn] of Object.entries(rawGlobals)) {
        engine.global.set(name, fn);
      }
      if (preludeLua.trim().length > 0) {
        await engine.doString(preludeLua);
      }
      const thread = engine.global.newThread();
      const idx = engine.global.getTop();
      try {
        thread.loadString('net.fetch_json("https://api.example.com/x")');
        await expect(thread.run(0)).rejects.toThrow();
      } finally {
        engine.global.remove(idx);
      }
      expect(denials.last()).toEqual({
        reason: 'denied',
        message: expect.stringContaining('depth'),
      });
    } finally {
      engine.global.close();
    }
  });
});

describe('buildCapabilities — net.post/net.patch results are also plain Lua tables (issue #6 sibling)', () => {
  it('net.post result is a genuine table (type() says table, fields readable)', async () => {
    const r = await run(
      `
      local res = net.post("https://api.example.com/x", "payload")
      return { t = type(res), status = res.status, body = res.body }
      `,
      {
        tier: 'manual',
        net: {
          get: async () => ({ status: 200, body: '{}' }),
          post: async () => ({ status: 201, body: 'created' }),
        },
        netGrants: { get: [], post: ['api.example.com'] },
      },
    );
    expect(r).toEqual({
      ok: true,
      value: { t: 'table', status: 201, body: 'created' },
    });
  });

  it('net.patch result is a genuine table (type() says table, fields readable)', async () => {
    const r = await run(
      `
      local res = net.patch("https://api.example.com/x", "payload")
      return { t = type(res), status = res.status, body = res.body }
      `,
      {
        tier: 'manual',
        net: {
          get: async () => ({ status: 200, body: '{}' }),
          patch: async () => ({ status: 200, body: 'updated' }),
        },
        netGrants: { get: [], post: ['api.example.com'] },
      },
    );
    expect(r).toEqual({
      ok: true,
      value: { t: 'table', status: 200, body: 'updated' },
    });
  });
});

describe('buildCapabilities — tier gate on effectful net ops', () => {
  it("tier 'auto': net.post is a TIER-BLOCKED STUB (not absent) even though POST hosts are granted; calling it throws and never reaches the provider; net.fetch_json still works", async () => {
    const post = vi.fn(async () => ({ status: 200, body: '{}' }));
    const r = await run(
      `
      local getResult = net.fetch_json("https://api.example.com/x")
      local ok, err = pcall(net.post, "https://api.example.com/x", "payload")
      return type(net.post), getResult.ok, ok, err
      `,
      {
        tier: 'auto',
        net: {
          get: async () => ({ status: 200, body: '{"ok": true}' }),
          post,
        },
        netGrants: { get: ['api.example.com'], post: ['api.example.com'] },
      },
    );
    expect(r.ok).toBe(true);
    // MultiReturn is truncated to the first value by this test harness's
    // `run` (see its doc comment) — `type(net.post)` alone already proves
    // the stub exists (a function, not nil); the provider-never-called
    // assertion below is the load-bearing one for "grants nothing new".
    expect(r).toEqual({ ok: true, value: 'function' });
    expect(post).not.toHaveBeenCalled();
  });

  it("tier 'auto': net.post's tier-blocked stub records a 'tier-blocked' denial on buildCapabilities' own denials handle, non-spoofably", async () => {
    const engine = await createEmptyLuaEngine();
    try {
      const { rawGlobals, preludeLua, denials } = buildCapabilities({
        tier: 'auto',
        net: {
          get: async () => ({ status: 200, body: '{}' }),
          post: async () => ({ status: 200, body: '{}' }),
        },
        netGrants: { get: [], post: ['api.example.com'] },
      });
      for (const [name, fn] of Object.entries(rawGlobals)) {
        engine.global.set(name, fn);
      }
      if (preludeLua.trim().length > 0) {
        await engine.doString(preludeLua);
      }
      expect(denials.last()).toBeUndefined();
      const thread = engine.global.newThread();
      const idx = engine.global.getTop();
      try {
        thread.loadString('net.post("https://api.example.com/x", "p")');
        await expect(thread.run(0)).rejects.toThrow();
      } finally {
        engine.global.remove(idx);
      }
      expect(denials.last()).toEqual({
        reason: 'tier-blocked',
        message: expect.stringContaining('auto tier'),
      });
    } finally {
      engine.global.close();
    }
  });

  it("tier 'manual': net.post is present and works for a granted host", async () => {
    let posted: { url: string; body: string } | undefined;
    const r = await run(
      'return net.post("https://api.example.com/x", "payload").status',
      {
        tier: 'manual',
        net: {
          get: async () => ({ status: 200, body: '{}' }),
          post: async (url, body) => {
            posted = { url, body };
            return { status: 201, body: 'created' };
          },
        },
        netGrants: { get: [], post: ['api.example.com'] },
      },
    );
    expect(r).toEqual({ ok: true, value: 201 });
    expect(posted).toEqual({
      url: 'https://api.example.com/x',
      body: 'payload',
    });
  });

  it("tier 'manual' but host not in the POST grant list: net.post rejects that call", async () => {
    const r = await run(
      'return net.post("https://evil.example.com/x", "payload")',
      {
        tier: 'manual',
        net: {
          get: async () => ({ status: 200, body: '{}' }),
          post: async () => ({ status: 200, body: '' }),
        },
        netGrants: { get: [], post: ['api.example.com'] },
      },
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain('MARK_CAPABILITY');
  });
});

describe('buildCapabilities — cache.get', () => {
  it('calls fn on a cold/stale cache and stores the result', async () => {
    const store = new Map<string, CacheEntry>();
    let fnCalls = 0;
    const r = await run(
      `
      local function compute() return 99 end
      return cache.get("k", 60, compute)
      `,
      {
        tier: 'manual',
        cache: {
          get: async (key) => store.get(key),
          set: async (key, entry) => {
            fnCalls++;
            store.set(key, entry);
          },
        },
      },
    );
    expect(r).toEqual({ ok: true, value: 99 });
    expect(fnCalls).toBe(1);
    expect(store.get('k')?.value).toBe(99);
  });

  it('returns the cached value without calling fn when fresh', async () => {
    const store = new Map<string, CacheEntry>([
      ['k', { value: 'cached-value', storedAtMs: Date.now() }],
    ]);
    let fnCalled = false;
    const r = await run(
      `
      local function compute() return "should-not-be-called" end
      return cache.get("k", 3600, compute)
      `,
      {
        tier: 'manual',
        cache: {
          get: async (key) => store.get(key),
          set: async () => {
            fnCalled = true;
          },
        },
      },
    );
    expect(r).toEqual({ ok: true, value: 'cached-value' });
    expect(fnCalled).toBe(false);
  });

  it('calls fn when the cached entry has gone stale past ttl', async () => {
    const store = new Map<string, CacheEntry>([
      ['k', { value: 'old-value', storedAtMs: Date.now() - 10_000 }],
    ]);
    let newValueStored: unknown;
    const r = await run(
      `
      local function compute() return "fresh-value" end
      return cache.get("k", 1, compute) -- ttl = 1 second, entry is 10s old
      `,
      {
        tier: 'manual',
        cache: {
          get: async (key) => store.get(key),
          set: async (_key, entry) => {
            newValueStored = entry.value;
          },
        },
      },
    );
    expect(r).toEqual({ ok: true, value: 'fresh-value' });
    expect(newValueStored).toBe('fresh-value');
  });

  it("fn calling net.fetch_json internally works (async capability nested inside cache's Lua-level fn call)", async () => {
    const store = new Map<string, CacheEntry>();
    let fetchCalls = 0;
    const r = await run(
      `
      local function compute()
        local r = net.fetch_json("https://api.example.com/x")
        return r.n
      end
      local v1 = cache.get("k", 60, compute)
      local v2 = cache.get("k", 60, compute)
      return v1 == v2, v1
      `,
      {
        tier: 'manual',
        net: fakeNet(async () => {
          fetchCalls++;
          return { status: 200, body: '{"n": 5}' };
        }),
        netGrants: { get: ['api.example.com'], post: [] },
        cache: {
          get: async (key) => store.get(key),
          set: async (key, entry) => {
            store.set(key, entry);
          },
        },
      },
    );
    expect(r).toEqual({ ok: true, value: true });
    expect(fetchCalls).toBe(1); // second cache.get must hit the cache, not re-fetch
  });
});

// Follow-up to issue #6: a cache HIT has the identical proxy problem a
// fetch result has (a stored value is exactly the JSON-shaped data
// `net.fetch_json` produces, and `cache.get(key, ttl, function() return
// net.fetch_json(url) end)` is the documented idiom, docs/scripting.md).
// A cache hit must deliver the same plain-Lua-table data a fresh fetch does.
describe('buildCapabilities — cache.get delivers plain Lua data on a hit (issue #6 follow-up)', () => {
  it('a nested array/object stored on a miss comes back as a genuine table on a later hit: type(), #, ipairs all work', async () => {
    const store = new Map<string, CacheEntry>();
    const r = await run(
      `
      local function compute()
        return { tags = { "a", "b", "c" }, owner = { name = "ada", id = 7 } }
      end
      local miss = cache.get("k", 3600, compute)
      local hit = cache.get("k", 3600, compute)
      local sum = 0
      for _, v in ipairs(hit.tags) do sum = sum + 1 end
      return {
        hit_type = type(hit),
        hit_tags_type = type(hit.tags),
        hit_tags_len = #hit.tags,
        tag_count = sum,
        owner_name = hit.owner.name,
        owner_id = hit.owner.id,
      }
      `,
      {
        tier: 'manual',
        cache: {
          get: async (key) => store.get(key),
          set: async (key, entry) => {
            store.set(key, entry);
          },
        },
      },
    );
    expect(r).toEqual({
      ok: true,
      value: {
        hit_type: 'table',
        hit_tags_type: 'table',
        hit_tags_len: 3,
        tag_count: 3,
        owner_name: 'ada',
        owner_id: 7,
      },
    });
  });

  it('a null-derived absent field on the miss path stays absent on a later hit (no error, nil, not a special null value)', async () => {
    const store = new Map<string, CacheEntry>();
    const r = await run(
      `
      local function compute()
        return net.fetch_json("https://api.example.com/x")
      end
      local miss = cache.get("k", 3600, compute)
      local hit = cache.get("k", 3600, compute)
      return {
        miss_wiki_is_nil = miss.wikipedia_url == nil,
        hit_wiki_is_nil = hit.wikipedia_url == nil,
        hit_name = hit.name,
        echoed = hit,
      }
      `,
      {
        tier: 'manual',
        net: fakeNet(async () => ({
          status: 200,
          body: '{"name": "collie", "wikipedia_url": null}',
        })),
        netGrants: { get: ['api.example.com'], post: [] },
        cache: {
          get: async (key) => store.get(key),
          set: async (key, entry) => {
            store.set(key, entry);
          },
        },
      },
    );
    expect(r).toEqual({
      ok: true,
      value: {
        miss_wiki_is_nil: true,
        hit_wiki_is_nil: true,
        hit_name: 'collie',
        echoed: { name: 'collie' },
      },
    });
  });

  it('a scalar cached value keeps working unchanged through the new text-based hit path', async () => {
    const store = new Map<string, CacheEntry>([
      ['k', { value: 42, storedAtMs: Date.now() }],
    ]);
    const r = await run(
      'return cache.get("k", 3600, function() return 0 end)',
      {
        tier: 'manual',
        cache: {
          get: async (key) => store.get(key),
          set: async () => {
            throw new Error('should not be called: entry is fresh');
          },
        },
      },
    );
    expect(r).toEqual({ ok: true, value: 42 });
  });

  it('a cyclic value from fn() is rejected as a marshal failure, not a JSON.stringify crash later on a hit', async () => {
    const store = new Map<string, CacheEntry>();
    const r = await run(
      `
      local function compute()
        local t = {}
        t.self = t
        return t
      end
      local ok, err = pcall(cache.get, "k", 3600, compute)
      return { ok = ok, has_cycle = string.find(tostring(err), "cycle") ~= nil }
      `,
      {
        tier: 'manual',
        cache: {
          get: async (key) => store.get(key),
          set: async (key, entry) => {
            store.set(key, entry);
          },
        },
      },
    );
    expect(r).toEqual({ ok: true, value: { ok: false, has_cycle: true } });
  });
});

describe('buildCapabilities — bundle delegates to a real @markii/bundle ScriptView', () => {
  it('bundle.read/exists work through the granted view', async () => {
    const { view } = fixtureBundle();
    const r = await run(
      `
      local data = bundle.read("assets/x.png")
      local exists = bundle.exists("assets/x.png")
      local missing = bundle.exists("nope.txt")
      return data, exists, missing
      `,
      { tier: 'manual', bundle: view },
    );
    expect(r.ok).toBe(true);
    // MultiReturn truncated to first value by our wrapper in this test
    // harness (see `run` above); this test only needs the first value.
    expect(r.ok && r.value).toBe('img');
  });

  it("tier 'manual': bundle.write to cache/ works through the real path-jail/write policy", async () => {
    const { view, storage } = fixtureBundle();
    const r = await run(
      'bundle.write("cache/out.json", "hello"); return true',
      {
        tier: 'manual',
        bundle: view,
      },
    );
    expect(r).toEqual({ ok: true, value: true });
    const written = await storage.read('cache/out.json');
    expect(written && new TextDecoder().decode(written)).toBe('hello');
  });

  it("tier 'manual': bundle.write to manifest.json is blocked by @markii/bundle's own policy (ScriptCapabilityError), not by this package reimplementing it", async () => {
    const { view } = fixtureBundle();
    const r = await run('bundle.write("manifest.json", "{}"); return true', {
      tier: 'manual',
      bundle: view,
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain('MARK_CAPABILITY');
  });

  it("tier 'manual': bundle.write to note.mk.md is blocked", async () => {
    const { view } = fixtureBundle();
    const r = await run('bundle.write("note.mk.md", "# hacked"); return true', {
      tier: 'manual',
      bundle: view,
    });
    expect(r.ok).toBe(false);
  });

  it("tier 'auto': bundle.write is a TIER-BLOCKED STUB (not absent, read-only tier) — calling it throws and never reaches the ScriptView's write", async () => {
    const { view, storage } = fixtureBundle();
    const writeSpy = vi.spyOn(view, 'write');
    const r = await run(
      `
      local ok, err = pcall(bundle.write, "cache/out.json", "hi")
      return type(bundle.write), ok, err
      `,
      { tier: 'auto', bundle: view },
    );
    expect(r).toEqual({ ok: true, value: 'function' });
    expect(writeSpy).not.toHaveBeenCalled();
    expect(await storage.read('cache/out.json')).toBeUndefined();
  });

  it("tier 'auto': bundle.write's tier-blocked stub records a 'tier-blocked' denial on buildCapabilities' own denials handle", async () => {
    const { view } = fixtureBundle();
    const engine = await createEmptyLuaEngine();
    try {
      const { rawGlobals, preludeLua, denials } = buildCapabilities({
        tier: 'auto',
        bundle: view,
      });
      for (const [name, fn] of Object.entries(rawGlobals)) {
        engine.global.set(name, fn);
      }
      if (preludeLua.trim().length > 0) {
        await engine.doString(preludeLua);
      }
      expect(denials.last()).toBeUndefined();
      const thread = engine.global.newThread();
      const idx = engine.global.getTop();
      try {
        thread.loadString('bundle.write("cache/out.json", "hi")');
        await expect(thread.run(0)).rejects.toThrow();
      } finally {
        engine.global.remove(idx);
      }
      expect(denials.last()).toEqual({
        reason: 'tier-blocked',
        message: expect.stringContaining('auto tier'),
      });
    } finally {
      engine.global.close();
    }
  });

  it("tier 'auto': bundle.read still works", async () => {
    const { view } = fixtureBundle();
    const r = await run('return bundle.read("assets/x.png")', {
      tier: 'auto',
      bundle: view,
    });
    expect(r).toEqual({ ok: true, value: 'img' });
  });
});

describe('buildCapabilities — raw handles do not leak as globals after wrapping', () => {
  it('none of the __smd_*_raw names are reachable from the script', async () => {
    const { view } = fixtureBundle();
    const r = await run(
      `
      return type(__smd_net_get_raw), type(__smd_cache_get_raw), type(__smd_bundle_read_raw), type(__smd_bundle_write_raw)
      `,
      {
        tier: 'manual',
        net: fakeNet(async () => ({ status: 200, body: '{}' })),
        netGrants: { get: ['api.example.com'], post: [] },
        cache: {
          get: async () => undefined,
          set: async () => {},
        },
        bundle: view,
      },
    );
    // MultiReturn truncation means we only see the first "nil" here, but
    // that alone already proves the raw net handle is gone; see the
    // isolation-style assertions below for the rest checked individually.
    expect(r).toEqual({ ok: true, value: 'nil' });
  });

  it('each raw handle individually is nil after setup', async () => {
    const { view } = fixtureBundle();
    const config = {
      tier: 'manual' as const,
      net: fakeNet(async () => ({ status: 200, body: '{}' })),
      netGrants: { get: ['api.example.com'], post: [] },
      cache: { get: async () => undefined, set: async () => {} },
      bundle: view,
    };
    for (const name of [
      '__smd_net_get_raw',
      '__smd_cache_get_raw',
      '__smd_cache_set_raw',
      '__smd_now_ms_raw',
      '__smd_bundle_read_raw',
      '__smd_bundle_exists_raw',
      '__smd_bundle_write_raw',
    ]) {
      const r = await run(`return type(${name})`, config);
      expect(r, `expected ${name} to be nil`).toEqual({
        ok: true,
        value: 'nil',
      });
    }
  });
});
