import { createRequire } from 'node:module';
import { zipSync } from 'fflate';
import {
  createScriptView,
  openZipBundle,
  type BundleManifest,
} from '@markii/bundle';
import { describe, expect, it, vi } from 'vitest';
import { DENIED_GLOBALS } from './globals';
import type { ScriptLimits } from './limits';
import * as marshalModule from './marshal';
import { runScript, type RunScriptOptions } from './sandbox';
import type { CacheEntry } from './capabilities';

function u8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function fixtureBundleView() {
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

/** Small limits by default so the whole adversarial suite runs in milliseconds. */
const FAST_LIMITS: Partial<ScriptLimits> = {
  maxInstructions: 2_000_000,
  wallClockMs: 500,
  hookIntervalInstructions: 5_000,
  maxMemoryBytes: 8 * 1024 * 1024,
};

async function run(code: string, options: Partial<RunScriptOptions> = {}) {
  return runScript({
    code,
    tier: 'manual',
    limits: FAST_LIMITS,
    ...options,
  });
}

describe('runScript — happy path', () => {
  it('returns a simple value', async () => {
    const r = await run('return 1 + 1');
    expect(r).toEqual({ ok: true, value: 2 });
  });

  it('returns a nested table', async () => {
    const r = await run('return { a = 1, b = { "x", "y" } }');
    expect(r).toEqual({ ok: true, value: { a: 1, b: ['x', 'y'] } });
  });

  it('never throws, even for a syntax error — reported as a typed runtime failure', async () => {
    const r = await run('this is not lua (');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe('runtime');
  });
});

describe('runScript — sandbox escape attempts all come back as typed failures, never a host compromise', () => {
  it.each(DENIED_GLOBALS)('"%s" is nil inside the script', async (name) => {
    const r = await run(`return type(${name})`);
    expect(r).toEqual({ ok: true, value: 'nil' });
  });

  it('load(...) of a string is impossible', async () => {
    const r = await run('return type(load)');
    expect(r).toEqual({ ok: true, value: 'nil' });
  });

  it('calling a supposed "load" as if it existed fails safely', async () => {
    const r = await run('load("return 1")()');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe('runtime');
  });

  it('getmetatable/setmetatable tampering on the string type cannot restore string.dump', async () => {
    const r = await run(`
      local ok = pcall(function()
        local mt = getmetatable("")
        mt.dump = function() end
      end)
      return tostring(ok) .. ":" .. tostring(string.dump)
    `);
    expect(r).toEqual({ ok: true, value: 'false:nil' });
  });
});

describe('runScript — resource limits', () => {
  it('a bare infinite loop is killed by the instruction limit', async () => {
    const r = await run('while true do end');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe('limit');
    expect(!r.ok && r.error.limit).toBe('instructions');
  });

  it("the crucial case: a script's own pcall around an infinite loop does not let the run 'succeed'", async () => {
    const r = await run(`
      local ok = pcall(function() while true do end end)
      return "should never get here:" .. tostring(ok)
    `);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe('limit');
  });

  it('wall-clock kill fires even with a very high instruction cap', async () => {
    const r = await run('while true do end', {
      limits: {
        ...FAST_LIMITS,
        maxInstructions: 5_000_000_000,
        wallClockMs: 150,
      },
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe('limit');
    expect(!r.ok && r.error.limit).toBe('timeout');
  });

  it('memory cap stops a string.rep balloon without OOM-ing the process', async () => {
    const r = await run(
      "local ok, err = pcall(function() return string.rep('x', 500*1024*1024) end); return tostring(ok)",
      { limits: { ...FAST_LIMITS, maxMemoryBytes: 4 * 1024 * 1024 } },
    );
    // The script's own pcall catches the "not enough memory" Lua error
    // (an ordinary catchable error, unlike the limit-hook interrupt) and
    // the run completes "successfully" reporting ok=false at the LUA
    // level -- that is a correct, safe outcome: the memory was capped
    // (not a process OOM), and the script observed its own allocation
    // failing, same as any other pcall'd error.
    expect(r).toEqual({ ok: true, value: 'false' });
  });

  it('deep (non-tail-call) recursion overflows the Lua C stack safely, catchable by the script', async () => {
    const r = await run(`
      local function rec(n) return 1 + rec(n + 1) end
      local ok = pcall(rec, 1)
      return tostring(ok)
    `);
    expect(r).toEqual({ ok: true, value: 'false' });
  });
});

describe('runScript — memory-breach classification is exact, not message-based (Defect 2)', () => {
  it('a genuine, UNCAUGHT memory-cap breach is classified as kind:"limit", limit:"memory"', async () => {
    const r = await run(
      `
      local t = {}
      for i = 1, 100000000 do t[i] = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" end
      return #t
      `,
      {
        limits: {
          maxInstructions: 200_000_000,
          wallClockMs: 5_000,
          hookIntervalInstructions: 5_000,
          maxMemoryBytes: 2 * 1024 * 1024,
        },
      },
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe('limit');
    expect(!r.ok && r.error.limit).toBe('memory');
  });

  it('a script calling error("not enough memory") itself is NOT reclassified as a memory limit (spoofing attempt fails)', async () => {
    // Same message text a real memory-cap breach produces, but raised by
    // the script's own `error()` call under a generous memory cap that is
    // nowhere near exhausted -- the classifier must tell these apart by the
    // non-spoofable LuaReturn status code (see `captureAssertOkStatus` in
    // `./sandbox`), not by matching this string.
    const r = await run('error("not enough memory")');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe('runtime');
  });

  it("a script's OWN pcall around a memory-cap breach still reports as an ordinary caught error, not a limit failure", async () => {
    // Regression guard: the memory-status capture must not fire for a
    // breach the SCRIPT already caught at the Lua level (lua_pcall absorbs
    // the ErrorMem status internally; the outer lua_resume/thread.run()
    // still completes with LuaReturn.Ok). Duplicates the existing "memory
    // cap stops a string.rep balloon" case above; kept here as an explicit
    // adjacency check for the new classification logic.
    const r = await run(
      "local ok = pcall(function() return string.rep('x', 500*1024*1024) end); return tostring(ok)",
      { limits: { ...FAST_LIMITS, maxMemoryBytes: 4 * 1024 * 1024 } },
    );
    expect(r).toEqual({ ok: true, value: 'false' });
  });
});

describe('runScript — async wall-clock guard classification is identity-based, not message-based (Defect 3)', () => {
  it('a host capability call that never resolves is classified as kind:"limit", limit:"timeout"', async () => {
    const r = await run('return net.fetch_json("https://api.example.com/x")', {
      net: {
        // Never resolves -- simulates a hung host operation the in-VM
        // instruction hook structurally cannot see (no Lua instructions
        // execute while suspended on an await).
        get: () => new Promise(() => {}),
      },
      netGrants: { get: ['api.example.com'], post: [] },
      limits: {
        ...FAST_LIMITS,
        wallClockMs: 100,
      },
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe('limit');
    expect(!r.ok && r.error.limit).toBe('timeout');
  }, 5_000);

  it('a script calling error() with the EXACT guard message text is NOT reclassified as a limit (spoofing attempt fails)', async () => {
    // The guard identifies its own rejection by class identity
    // (`instanceof ScriptLimitError`), not by this message string, so a
    // script forging the same text must still come back as an ordinary
    // runtime error.
    const r = await run(
      'error("wall-clock timeout exceeded (external async guard: a host capability call never resolved)")',
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe('runtime');
  });
});

describe('runScript — capabilities: net', () => {
  it('with net not granted, net is absent and any use fails as a runtime error, not a crash', async () => {
    const r = await run('return net.fetch_json("https://x.example.com")');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe('runtime');
  });

  it("tier 'auto': net.fetch_json works via a fake provider; net.post is a tier-blocked stub (a function, not nil) whose call fails as kind: 'capability', capability: 'tier-blocked'", async () => {
    const r = await run(
      `
      local data = net.fetch_json("https://api.example.com/x")
      return data.ok, type(net.post)
      `,
      {
        tier: 'auto',
        net: {
          get: async () => ({ status: 200, body: '{"ok": true}' }),
          post: async () => ({ status: 200, body: '{}' }),
        },
        netGrants: { get: ['api.example.com'], post: ['api.example.com'] },
      },
    );
    expect(r).toEqual({ ok: true, value: true });

    const call = await run(
      'return net.post("https://api.example.com/x", "p")',
      {
        tier: 'auto',
        net: {
          get: async () => ({ status: 200, body: '{}' }),
          post: async () => ({ status: 200, body: '{}' }),
        },
        netGrants: { get: [], post: ['api.example.com'] },
      },
    );
    expect(call.ok).toBe(false);
    expect(!call.ok && call.error.kind).toBe('capability');
    expect(!call.ok && call.error.capability).toBe('tier-blocked');
  });

  it('fetch over the size cap is rejected as a typed capability failure', async () => {
    const r = await run('return net.fetch_json("https://api.example.com/x")', {
      net: { get: async () => ({ status: 200, body: 'x'.repeat(10_000) }) },
      netGrants: { get: ['api.example.com'], post: [] },
      maxFetchBytes: 100,
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe('capability');
  });
});

// GitHub issue #6, full pipeline (runScript, including the return-value
// marshal walk — not just buildCapabilities in isolation; see
// capabilities.test.ts for the narrower, in-Lua-only assertions).
describe('runScript — net.fetch_json delivers plain Lua data, end to end (issue #6)', () => {
  it('returning a nested array taken directly from the fetch result round-trips (used to fail with kind:"marshal", reason:"type")', async () => {
    const r = await run(
      'return net.fetch_json("https://api.example.com/x").items',
      {
        net: {
          get: async () => ({
            status: 200,
            body: '{"items": [1, 2, {"nested": true}]}',
          }),
        },
        netGrants: { get: ['api.example.com'], post: [] },
      },
    );
    expect(r).toEqual({ ok: true, value: [1, 2, { nested: true }] });
  });

  it('a JSON null field reads as nil with no error; a table with that field absent marshals cleanly', async () => {
    const r = await run(
      `
      local breed = net.fetch_json("https://api.example.com/x")
      local url = breed.wikipedia_url
      assert(url == nil, "expected nil, not an error or a special null value")
      return breed
      `,
      {
        net: {
          get: async () => ({
            status: 200,
            body: '{"name": "collie", "wikipedia_url": null}',
          }),
        },
        netGrants: { get: ['api.example.com'], post: [] },
      },
    );
    expect(r).toEqual({ ok: true, value: { name: 'collie' } });
  });

  it('#result, ipairs, and type(result) work on a top-level JSON array', async () => {
    const r = await run(
      `
      local result = net.fetch_json("https://api.example.com/x")
      local sum = 0
      for _, v in ipairs(result) do sum = sum + v end
      return { t = type(result), len = #result, sum = sum }
      `,
      {
        net: { get: async () => ({ status: 200, body: '[10, 20, 30]' }) },
        netGrants: { get: ['api.example.com'], post: [] },
      },
    );
    expect(r).toEqual({ ok: true, value: { t: 'table', len: 3, sum: 60 } });
  });

  it('a depth-cap-exceeding response fails cleanly and is catchable with pcall; the sandbox stays alive for the rest of the script', async () => {
    let body = '0';
    for (let i = 0; i < 40; i++) body = `{"n": ${body}}`;
    const r = await run(
      `
      local ok, err = pcall(net.fetch_json, "https://api.example.com/x")
      return { ok = ok, has_depth = string.find(tostring(err), "depth") ~= nil, alive = 1 + 1 }
      `,
      {
        net: { get: async () => ({ status: 200, body }) },
        netGrants: { get: ['api.example.com'], post: [] },
      },
    );
    expect(r).toEqual({
      ok: true,
      value: { ok: false, has_depth: true, alive: 2 },
    });
  });

  it('a node-cap-exceeding response fails cleanly and is catchable with pcall', async () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const r = await run(
      `
      local ok, err = pcall(net.fetch_json, "https://api.example.com/x")
      return { ok = ok, has_nodes = string.find(tostring(err), "node") ~= nil }
      `,
      {
        net: {
          get: async () => ({ status: 200, body: JSON.stringify(items) }),
        },
        netGrants: { get: ['api.example.com'], post: [] },
        marshalLimits: { maxDepth: 32, maxNodes: 10 },
      },
    );
    expect(r).toEqual({ ok: true, value: { ok: false, has_nodes: true } });
  });

  it('an uncaught depth-cap failure is classified as kind:"capability", not a raw crash', async () => {
    let body = '0';
    for (let i = 0; i < 40; i++) body = `{"n": ${body}}`;
    const r = await run('return net.fetch_json("https://api.example.com/x")', {
      net: { get: async () => ({ status: 200, body }) },
      netGrants: { get: ['api.example.com'], post: [] },
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe('capability');
    expect(!r.ok && r.error.message).toContain('depth');
  });

  it('net.post/net.patch results are also genuine tables end to end (issue #6 sibling)', async () => {
    const r = await run(
      `
      local posted = net.post("https://api.example.com/x", "payload")
      local patched = net.patch("https://api.example.com/x", "payload")
      return {
        post_type = type(posted), post_status = posted.status, post_body = posted.body,
        patch_type = type(patched), patch_status = patched.status, patch_body = patched.body,
      }
      `,
      {
        net: {
          get: async () => ({ status: 200, body: '{}' }),
          post: async () => ({ status: 201, body: 'created' }),
          patch: async () => ({ status: 200, body: 'updated' }),
        },
        netGrants: { get: [], post: ['api.example.com'] },
      },
    );
    expect(r).toEqual({
      ok: true,
      value: {
        post_type: 'table',
        post_status: 201,
        post_body: 'created',
        patch_type: 'table',
        patch_status: 200,
        patch_body: 'updated',
      },
    });
  });
});

describe('runScript — capabilities: cache', () => {
  it('cache.get returns cached without calling fn when fresh, calls fn when stale', async () => {
    const store = new Map<string, { value: unknown; storedAtMs: number }>();
    const cache = {
      get: async (key: string) => store.get(key),
      set: async (
        key: string,
        entry: { value: unknown; storedAtMs: number },
      ) => {
        store.set(key, entry);
      },
    };

    const script = `
      local function compute() return "computed" end
      return cache.get("k", 3600, compute)
    `;
    const r1 = await run(script, { cache });
    expect(r1).toEqual({ ok: true, value: 'computed' });

    // fn tracked on the JS side via the store, not directly counted here
    // (cache.get's `fn` runs entirely inside Lua) -- verify indirectly:
    // seed a DIFFERENT value directly into the store and confirm a fresh
    // cache.get call returns THAT value without re-running fn.
    store.set('k2', { value: 'preloaded', storedAtMs: Date.now() });
    const r2 = await run(
      'local function compute() return "should-not-run" end; return cache.get("k2", 3600, compute)',
      { cache },
    );
    expect(r2).toEqual({ ok: true, value: 'preloaded' });
  });
});

// Follow-up to issue #6: cache.get(key, ttl, function() return
// net.fetch_json(url) end) is THE documented idiom (docs/scripting.md), so a
// cache HIT must deliver the same plain-Lua-table data a fresh MISS/fetch
// does — full pipeline, two entirely separate `runScript` calls sharing one
// backing store, exactly as two separate render passes of the same document
// would.
describe('runScript — cache.get hit-path parity with the miss path, end to end (issue #6 follow-up)', () => {
  it('a script run twice against a shared store/clock: run 1 misses and fetches, run 2 hits the cache — both runs marshal to the SAME (deep-equal) result', async () => {
    const store = new Map<string, { value: unknown; storedAtMs: number }>();
    const fixedNow = 1_000_000;
    const cache = {
      get: async (key: string) => store.get(key),
      set: async (
        key: string,
        entry: { value: unknown; storedAtMs: number },
      ) => {
        store.set(key, entry);
      },
    };
    let fetchCalls = 0;
    const net = {
      get: async () => {
        fetchCalls++;
        return {
          status: 200,
          body: '{"city": "berlin", "tags": ["cold", "rainy"], "wind": null, "readings": [1, 2, 3]}',
        };
      },
    };
    const script = `
      return cache.get("weather", 3600, function()
        return net.fetch_json("https://api.example.com/weather")
      end)
    `;
    const options = {
      net,
      netGrants: { get: ['api.example.com'], post: [] },
      cache,
    };

    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    try {
      const r1 = await run(script, options); // miss: fetches, then stores
      const r2 = await run(script, options); // hit: served from the store
      expect(r1.ok).toBe(true);
      expect(r2).toEqual(r1); // structurally identical marshaled results
      expect(fetchCalls).toBe(1);
      expect(r1).toEqual({
        ok: true,
        value: {
          city: 'berlin',
          tags: ['cold', 'rainy'],
          readings: [1, 2, 3],
          // "wind": null is absent on BOTH the miss and the hit path.
        },
      });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('the weather-script shape: cache.get wrapping fetch_json, a hit still returns nested arrays as real Lua tables (type/#/ipairs)', async () => {
    const store = new Map<string, { value: unknown; storedAtMs: number }>();
    const cache = {
      get: async (key: string) => store.get(key),
      set: async (
        key: string,
        entry: { value: unknown; storedAtMs: number },
      ) => {
        store.set(key, entry);
      },
    };
    const net = {
      get: async () => ({
        status: 200,
        body: '{"forecast": [{"day": "mon", "highs": [10, 12]}, {"day": "tue", "highs": [8, 9]}]}',
      }),
    };
    const script = `
      local function fetch()
        return net.fetch_json("https://api.example.com/weather")
      end
      cache.get("weather", 3600, fetch) -- miss: populates the cache
      local data = cache.get("weather", 3600, fetch) -- hit
      local total = 0
      for _, day in ipairs(data.forecast) do
        for _, h in ipairs(day.highs) do total = total + h end
      end
      return {
        t = type(data.forecast),
        days = #data.forecast,
        first_day = data.forecast[1].day,
        sum_of_highs = total,
        full = data,
      }
    `;
    const r = await run(script, {
      net,
      netGrants: { get: ['api.example.com'], post: [] },
      cache,
    });
    expect(r).toEqual({
      ok: true,
      value: {
        t: 'table',
        days: 2,
        first_day: 'mon',
        sum_of_highs: 39,
        full: {
          forecast: [
            { day: 'mon', highs: [10, 12] },
            { day: 'tue', highs: [8, 9] },
          ],
        },
      },
    });
  });
});

describe('runScript — capabilities: bundle', () => {
  it('bundle.write to cache/ works through a real ScriptView', async () => {
    const { view, storage } = fixtureBundleView();
    const r = await run('bundle.write("cache/out.json", "hi"); return true', {
      bundle: view,
    });
    expect(r).toEqual({ ok: true, value: true });
    expect(await storage.read('cache/out.json')).toEqual(u8('hi'));
  });

  it('bundle.write to manifest.json/note.mk.md is blocked through the real ScriptView, surfaced as a capability failure', async () => {
    const { view } = fixtureBundleView();
    const r = await run('bundle.write("manifest.json", "{}")', {
      bundle: view,
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe('capability');
  });

  it("tier 'auto': bundle.write is a tier-blocked stub (a function, not nil); calling it fails as kind: 'capability', capability: 'tier-blocked' without writing anything", async () => {
    const { view, storage } = fixtureBundleView();
    const typeResult = await run('return type(bundle.write)', {
      tier: 'auto',
      bundle: view,
    });
    expect(typeResult).toEqual({ ok: true, value: 'function' });

    const call = await run('bundle.write("cache/out.json", "hi")', {
      tier: 'auto',
      bundle: view,
    });
    expect(call.ok).toBe(false);
    expect(!call.ok && call.error.kind).toBe('capability');
    expect(!call.ok && call.error.capability).toBe('tier-blocked');
    expect(await storage.read('cache/out.json')).toBeUndefined();
  });
});

describe('runScript — marshalling', () => {
  it('a returned function is a typed marshal rejection', async () => {
    const r = await run('return function() end');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe('marshal');
    expect(!r.ok && r.error.reason).toBe('type');
  });

  it('a cyclic table is a typed marshal rejection', async () => {
    const r = await run('local t = {}; t.self = t; return t');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe('marshal');
    expect(!r.ok && r.error.reason).toBe('cycle');
  });

  it('a huge (1e6-key) table is rejected quickly via the node cap, not hung', async () => {
    const start = Date.now();
    // Building the 1e6-entry table itself needs headroom above
    // FAST_LIMITS (both instructions and memory) — the assertion under
    // test is that the MARSHAL node cap is what stops this quickly, not
    // that it's cheap to construct in the first place.
    const r = await run(
      'local t = {}; for i=1,1000000 do t[i]=i end; return t',
      {
        limits: {
          ...FAST_LIMITS,
          maxInstructions: 200_000_000,
          maxMemoryBytes: 64 * 1024 * 1024,
          wallClockMs: 5_000,
        },
        marshalLimits: { maxNodes: 5_000, maxDepth: 32 },
      },
    );
    expect(Date.now() - start).toBeLessThan(3_000);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe('marshal');
    expect(!r.ok && r.error.reason).toBe('nodes');
  });

  it('NaN is a typed marshal rejection, not silently null', async () => {
    const r = await run('return 0/0');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe('marshal');
    expect(!r.ok && r.error.reason).toBe('non-finite-number');
  });
});

describe('runScript — marshal caps are immune to global rebinding (Finding F-1)', () => {
  // The marshal prelude's walk used to resolve error/type/pairs/math.floor
  // as DYNAMIC GLOBAL lookups, executed AFTER the untrusted user chunk had
  // already run in the same globals table -- so a script rebinding those
  // names could neuter its own caps. The fix captures them into locals at
  // prelude-DEFINITION time (before user code ever runs), so the walk
  // closes over the genuine primitives as upvalues regardless of what the
  // script does to the globals table afterward.
  //
  // Mutation check (reasoned from the audit, not re-run: reverting the fix
  // to `math.floor(k) ~= k` / bare global `error`/`type`/`pairs` restores
  // the dynamic lookup, and with `error` rebound to a no-op before the walk
  // runs, `error("MARK_MARSHAL:nodes")` inside the walk becomes a silent
  // no-op call instead of a raise -- the walk keeps going, `__smd_marshal`
  // returns the full 100,000-element table, and this test would observe
  // `ok: true` with a 100k-length array instead of the expected
  // `ok: false, reason: 'nodes'`. This exactly reproduces the audit's
  // probe A1 result.
  it('rebinding `error` to a no-op does not defeat the node cap', async () => {
    const r = await run(
      `
      error = function() end
      local t = {}
      for i = 1, 100000 do t[i] = i end
      return t
      `,
      { marshalLimits: { maxNodes: 20_000, maxDepth: 32 } },
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe('marshal');
    expect(!r.ok && r.error.reason).toBe('nodes');
  });

  it('rebinding `type` to mislabel values does not defeat the depth cap', async () => {
    const r = await run(
      `
      local realType = type
      type = function(v) return "string" end
      local t = { n = 1 }
      for i = 1, 200 do t = { n = t } end
      return t
      `,
      { marshalLimits: { maxNodes: 100_000, maxDepth: 10 } },
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe('marshal');
    expect(!r.ok && r.error.reason).toBe('depth');
  });

  it('rebinding `math.floor` does not defeat the key-type cap on a fractional key', async () => {
    const r = await run(
      `
      math.floor = function(x) return x end
      return { [1.5] = "x" }
      `,
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe('marshal');
    expect(!r.ok && r.error.reason).toBe('key-type');
  });
});

describe('runScript — embedded NUL bytes in returned strings are rejected (Finding F-2)', () => {
  // wasmoon truncates a Lua string at its first NUL byte when converting to
  // JS -- by the time a NUL-containing string reaches JS it has already
  // silently lost data, so detection has to happen on the Lua side (in the
  // marshal walk, via `string.find`) before that truncation occurs.
  it('a top-level returned string with an embedded NUL is rejected, not silently truncated', async () => {
    const r = await run('return "a" .. string.char(0) .. "b"');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe('marshal');
    expect(!r.ok && r.error.reason).toBe('nul-byte');
  });

  it('a NUL nested inside a returned table string is rejected the same way', async () => {
    const r = await run('return { note = "a" .. string.char(0) .. "b" }');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe('marshal');
    expect(!r.ok && r.error.reason).toBe('nul-byte');
  });

  it('an ordinary string with no NUL still round-trips fine (no false positive)', async () => {
    const r = await run('return "a normal string, no null bytes here"');
    expect(r).toEqual({
      ok: true,
      value: 'a normal string, no null bytes here',
    });
  });
});

describe('runScript — isolation across runs', () => {
  it('a global set in one run is absent in the next', async () => {
    const r1 = await run('leaked = 42; return leaked');
    expect(r1).toEqual({ ok: true, value: 42 });

    const r2 = await run('return leaked');
    expect(r2).toEqual({ ok: true, value: null });
  });

  it('a metatable-poisoning attempt in one run (even if it somehow succeeded) cannot affect the next run — separate engine, separate memory entirely', async () => {
    // Run A tries every angle it has (all should individually fail safely
    // — getmetatable is absent — but the point of this test is the
    // ISOLATION property, not re-proving those already-covered failures).
    await run(`
      local ok = pcall(function()
        local mt = getmetatable("")
        mt.upper = function() return "POISONED" end
      end)
      return ok
    `);
    // Run B: a completely fresh engine. If poisoning had somehow leaked
    // (it can't -- separate wasmoon engine, separate WASM memory), this
    // would return "POISONED" instead of the real upper-case result.
    const r2 = await run('return ("abc"):upper()');
    expect(r2).toEqual({ ok: true, value: 'ABC' });
  });
});

describe('runScript — wasmUri option threads to the engine (CDN-avoidance, see ./globals)', () => {
  it('omitting wasmUri is unaffected — default resolution still runs correctly', async () => {
    const r = await run('return 1 + 1');
    expect(r).toEqual({ ok: true, value: 2 });
  });

  it('an explicit wasmUri is accepted and a full run (capabilities + sandbox scrub + marshal) still succeeds', async () => {
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve('wasmoon/dist/glue.wasm');

    const r = await run('return getmetatable == nil and ("x"):upper()', {
      wasmUri: wasmPath,
    });
    expect(r).toEqual({ ok: true, value: 'X' });
  });
});

describe('runScript — never raw-throws, even for an UNEXPECTED JS exception (audit F-1 "also recommended")', () => {
  // Every EXPECTED failure mode already returns a typed failure from inside
  // the try (limit breaches, capability denials, marshal rejections,
  // ordinary Lua runtime errors). This test targets the backstop `catch`
  // that now wraps the rest of the try block, for anything UNEXPECTED that
  // throws synchronously -- the audit's example was `finalizeMarshaledValue`
  // recursing deep enough to overflow the JS stack, which was previously
  // safe only INCIDENTALLY (wasmoon's own conversion overflows first on
  // deep input today; nothing guaranteed that ordering would hold forever).
  //
  // Deterministically reproducing an actual stack overflow at exactly the
  // right depth (deep enough to survive Lua's own recursion limit and
  // wasmoon's JS conversion, shallow enough — or rather deep enough only in
  // `finalizeMarshaledValue`'s own walk — to overflow only THIS function) is
  // inherently fragile and non-reproducible across engines/hardware. So
  // instead this forces the exact failure mode the audit named, directly
  // and reliably: `finalizeMarshaledValue` (a named export `sandbox.ts`
  // calls directly) is made to throw synchronously via `vi.spyOn` on the
  // live module binding, and a normal, otherwise-successful run is used to
  // reach that call. If the new `catch` were removed, this throw would
  // reject the returned promise instead of resolving it to a typed
  // failure -- `expect(...).resolves...` below would fail with an unhandled
  // rejection rather than the assertion.
  it('an unexpected throw from finalizeMarshaledValue is caught and reported as a typed runtime failure, not a rejected promise', async () => {
    const spy = vi
      .spyOn(marshalModule, 'finalizeMarshaledValue')
      .mockImplementation(() => {
        throw new Error('unexpected: simulated JS-side failure');
      });
    try {
      await expect(run('return 1 + 1')).resolves.toEqual({
        ok: false,
        error: {
          kind: 'runtime',
          message: 'unexpected: simulated JS-side failure',
        },
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('sanity: with the spy restored, the same script still succeeds normally', async () => {
    const r = await run('return 1 + 1');
    expect(r).toEqual({ ok: true, value: 2 });
  });
});

// Adversarial verification pass on the issue #6 fix (net.fetch_json /
// cache.get delivering plain Lua data): findings A1, A2, A4, B2, C2, D1.
describe('runScript — adversarial verification pass fixes', () => {
  it('A4: a hostile fetch response cannot spoof the internal array marker to force an array shape', async () => {
    const r = await run('return net.fetch_json("https://api.example.com/x")', {
      net: {
        get: async () => ({
          status: 200,
          body: '{"__smd_is_array": true, "1": "a", "2": "b", "x": "kept"}',
        }),
      },
      netGrants: { get: ['api.example.com'], post: [] },
    });
    expect(r).toEqual({ ok: true, value: { '1': 'a', '2': 'b', x: 'kept' } });
    expect(r.ok && Array.isArray(r.value)).toBe(false);
  });

  it('A4: a directly-tampered (host-stored) cache entry cannot spoof the array marker on a hit either', async () => {
    const store = new Map<string, { value: unknown; storedAtMs: number }>([
      [
        'k',
        {
          value: { __smd_is_array: true, '1': 'a', '2': 'b', x: 'kept' },
          storedAtMs: Date.now(),
        },
      ],
    ]);
    const cache = {
      get: async (key: string) => store.get(key),
      set: async () => {
        throw new Error('should not be called: entry is fresh');
      },
    };
    const r = await run(
      'return cache.get("k", 3600, function() return 0 end)',
      { cache },
    );
    expect(r).toEqual({ ok: true, value: { '1': 'a', '2': 'b', x: 'kept' } });
    expect(r.ok && Array.isArray(r.value)).toBe(false);
  });

  it('B2: a cache-hit value exceeding the node cap self-heals as a MISS — fn runs once, the fresh value comes back, and the stored entry is overwritten (orchestrator decision, #6 verification notes)', async () => {
    const bigArray = Array.from({ length: 50 }, (_, i) => i);
    const store = new Map<string, { value: unknown; storedAtMs: number }>([
      ['k', { value: bigArray, storedAtMs: Date.now() }],
    ]);
    let setCalls = 0;
    const cache = {
      get: async (key: string) => store.get(key),
      set: async (
        key: string,
        entry: { value: unknown; storedAtMs: number },
      ) => {
        setCalls++;
        store.set(key, entry);
      },
    };
    const r = await run(
      `
      local calls = 0
      local function compute() calls = calls + 1; return 42 end
      local result = cache.get("k", 3600, compute)
      return { result = result, calls = calls }
      `,
      { cache, marshalLimits: { maxDepth: 32, maxNodes: 10 } },
    );
    expect(r).toEqual({ ok: true, value: { result: 42, calls: 1 } });
    expect(setCalls).toBe(1);
    expect(store.get('k')?.value).toBe(42);
  });

  it('B2: a cyclic host-stored cache value self-heals as a MISS — the sandbox stays alive, fn runs, and the good value replaces the cyclic one', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const store = new Map<string, { value: unknown; storedAtMs: number }>([
      ['k', { value: cyclic, storedAtMs: Date.now() }],
    ]);
    let setCalls = 0;
    const cache = {
      get: async (key: string) => store.get(key),
      set: async (
        key: string,
        entry: { value: unknown; storedAtMs: number },
      ) => {
        setCalls++;
        store.set(key, entry);
      },
    };
    const r = await run(
      `
      local calls = 0
      local function compute() calls = calls + 1; return "fresh" end
      local result = cache.get("k", 3600, compute)
      return { result = result, calls = calls, alive = 1 + 1 }
      `,
      { cache },
    );
    expect(r).toEqual({
      ok: true,
      value: { result: 'fresh', calls: 1, alive: 2 },
    });
    expect(setCalls).toBe(1);
    expect(store.get('k')?.value).toBe('fresh');
  });

  it('B2: a BigInt-bearing host-stored cache value (JSON.stringify throws) self-heals as a MISS, not an unclassified crash', async () => {
    const store = new Map<string, { value: unknown; storedAtMs: number }>([
      ['k', { value: { big: 10n }, storedAtMs: Date.now() }],
    ]);
    let setCalls = 0;
    const cache = {
      get: async (key: string) => store.get(key),
      set: async (
        key: string,
        entry: { value: unknown; storedAtMs: number },
      ) => {
        setCalls++;
        store.set(key, entry);
      },
    };
    const r = await run(
      `
      local calls = 0
      local function compute() calls = calls + 1; return "fresh" end
      local result = cache.get("k", 3600, compute)
      return { result = result, calls = calls }
      `,
      { cache },
    );
    expect(r).toEqual({ ok: true, value: { result: 'fresh', calls: 1 } });
    expect(setCalls).toBe(1);
    expect(store.get('k')?.value).toBe('fresh');
  });

  it('B2 follow-up: an EXPIRED oversized entry also just refreshes, the same as a fresh oversized one', async () => {
    const bigArray = Array.from({ length: 50 }, (_, i) => i);
    const store = new Map<string, { value: unknown; storedAtMs: number }>([
      // Stored far outside any TTL — if the oversized entry were somehow
      // decoded before the freshness check, it would already look stale;
      // self-healing must short-circuit to a miss before that ever matters.
      ['k', { value: bigArray, storedAtMs: Date.now() - 1000 * 1000 }],
    ]);
    let setCalls = 0;
    const cache = {
      get: async (key: string) => store.get(key),
      set: async (
        key: string,
        entry: { value: unknown; storedAtMs: number },
      ) => {
        setCalls++;
        store.set(key, entry);
      },
    };
    const r = await run(
      `
      local calls = 0
      local function compute() calls = calls + 1; return 7 end
      local result = cache.get("k", 1, compute)
      return { result = result, calls = calls }
      `,
      { cache, marshalLimits: { maxDepth: 32, maxNodes: 10 } },
    );
    expect(r).toEqual({ ok: true, value: { result: 7, calls: 1 } });
    expect(setCalls).toBe(1);
    expect(store.get('k')?.value).toBe(7);
  });

  it('B2: a poisoned host-stored entry missing storedAtMs self-heals as a MISS instead of throwing a nil-arithmetic script error', async () => {
    const store = new Map<string, unknown>([['k', { value: 'poison' }]]);
    let setCalls = 0;
    const cache = {
      get: async (key: string) => store.get(key) as CacheEntry | undefined,
      set: async (
        key: string,
        entry: { value: unknown; storedAtMs: number },
      ) => {
        setCalls++;
        store.set(key, entry);
      },
    };
    const r = await run(
      `
      local calls = 0
      local function compute() calls = calls + 1; return "fresh" end
      local result = cache.get("k", 3600, compute)
      return { result = result, calls = calls }
      `,
      { cache },
    );
    expect(r).toEqual({ ok: true, value: { result: 'fresh', calls: 1 } });
    expect(setCalls).toBe(1);
    const stored = store.get('k') as { value: unknown; storedAtMs: number };
    expect(stored.value).toBe('fresh');
    expect(Number.isFinite(stored.storedAtMs)).toBe(true);
  });

  it('B2: a poisoned host-stored entry with a non-numeric storedAtMs self-heals as a MISS instead of throwing a type-mismatch script error', async () => {
    const store = new Map<string, unknown>([
      ['k', { value: 'poison', storedAtMs: 'abc' }],
    ]);
    let setCalls = 0;
    const cache = {
      get: async (key: string) => store.get(key) as CacheEntry | undefined,
      set: async (
        key: string,
        entry: { value: unknown; storedAtMs: number },
      ) => {
        setCalls++;
        store.set(key, entry);
      },
    };
    const r = await run(
      `
      local calls = 0
      local function compute() calls = calls + 1; return "fresh" end
      local result = cache.get("k", 3600, compute)
      return { result = result, calls = calls }
      `,
      { cache },
    );
    expect(r).toEqual({ ok: true, value: { result: 'fresh', calls: 1 } });
    expect(setCalls).toBe(1);
    const stored = store.get('k') as { value: unknown; storedAtMs: number };
    expect(stored.value).toBe('fresh');
    expect(Number.isFinite(stored.storedAtMs)).toBe(true);
  });

  it('B2: a poisoned host-stored entry with NaN/Infinity storedAtMs self-heals as a MISS', async () => {
    for (const badStoredAtMs of [NaN, Infinity, -Infinity]) {
      const store = new Map<string, unknown>([
        ['k', { value: 'poison', storedAtMs: badStoredAtMs }],
      ]);
      let setCalls = 0;
      const cache = {
        get: async (key: string) => store.get(key) as CacheEntry | undefined,
        set: async (
          key: string,
          entry: { value: unknown; storedAtMs: number },
        ) => {
          setCalls++;
          store.set(key, entry);
        },
      };
      const r = await run(
        `
        local calls = 0
        local function compute() calls = calls + 1; return "fresh" end
        local result = cache.get("k", 3600, compute)
        return { result = result, calls = calls }
        `,
        { cache },
      );
      expect(r).toEqual({ ok: true, value: { result: 'fresh', calls: 1 } });
      expect(setCalls).toBe(1);
      const stored = store.get('k') as { value: unknown; storedAtMs: number };
      expect(stored.value).toBe('fresh');
      expect(Number.isFinite(stored.storedAtMs)).toBe(true);
    }
  });

  it('B2: a poisoned host-stored entry that is not an object at all (e.g. a bare number) self-heals as a MISS', async () => {
    const store = new Map<string, unknown>([['k', 42]]);
    let setCalls = 0;
    const cache = {
      get: async (key: string) => store.get(key) as CacheEntry | undefined,
      set: async (
        key: string,
        entry: { value: unknown; storedAtMs: number },
      ) => {
        setCalls++;
        store.set(key, entry);
      },
    };
    const r = await run(
      `
      local calls = 0
      local function compute() calls = calls + 1; return "fresh" end
      local result = cache.get("k", 3600, compute)
      return { result = result, calls = calls }
      `,
      { cache },
    );
    expect(r).toEqual({ ok: true, value: { result: 'fresh', calls: 1 } });
    expect(setCalls).toBe(1);
    const stored = store.get('k') as { value: unknown; storedAtMs: number };
    expect(stored.value).toBe('fresh');
    expect(Number.isFinite(stored.storedAtMs)).toBe(true);
  });

  it('B2 regression: a VALID entry within TTL is still a hit (fn never called)', async () => {
    const store = new Map<string, unknown>([
      ['k', { value: 'good', storedAtMs: Date.now() }],
    ]);
    const cache = {
      get: async (key: string) => store.get(key) as CacheEntry | undefined,
      set: async () => {
        throw new Error('should not be called: entry is fresh');
      },
    };
    const r = await run(
      `
      local calls = 0
      local function compute() calls = calls + 1; return "fresh" end
      local result = cache.get("k", 3600, compute)
      return { result = result, calls = calls }
      `,
      { cache },
    );
    expect(r).toEqual({ ok: true, value: { result: 'good', calls: 0 } });
  });

  it('B2 regression: a VALID but expired entry still refreshes normally', async () => {
    const store = new Map<string, unknown>([
      ['k', { value: 'stale', storedAtMs: Date.now() - 1000 * 1000 }],
    ]);
    let setCalls = 0;
    const cache = {
      get: async (key: string) => store.get(key) as CacheEntry | undefined,
      set: async (
        key: string,
        entry: { value: unknown; storedAtMs: number },
      ) => {
        setCalls++;
        store.set(key, entry);
      },
    };
    const r = await run(
      `
      local calls = 0
      local function compute() calls = calls + 1; return "fresh" end
      local result = cache.get("k", 1, compute)
      return { result = result, calls = calls }
      `,
      { cache },
    );
    expect(r).toEqual({ ok: true, value: { result: 'fresh', calls: 1 } });
    expect(setCalls).toBe(1);
    const stored = store.get('k') as { value: unknown; storedAtMs: number };
    expect(stored.value).toBe('fresh');
  });

  it('N-1: a poisoned host-stored entry with a huge FUTURE storedAtMs (Number.MAX_SAFE_INTEGER*1000) self-heals as a MISS instead of being served as fresh forever', async () => {
    const store = new Map<string, unknown>([
      ['k', { value: 'POISON', storedAtMs: Number.MAX_SAFE_INTEGER * 1000 }],
    ]);
    let setCalls = 0;
    const cache = {
      get: async (key: string) => store.get(key) as CacheEntry | undefined,
      set: async (
        key: string,
        entry: { value: unknown; storedAtMs: number },
      ) => {
        setCalls++;
        store.set(key, entry);
      },
    };
    const before = Date.now();
    const r = await run(
      `
      local calls = 0
      local function compute() calls = calls + 1; return "fresh" end
      local result = cache.get("k", 3600, compute)
      return { result = result, calls = calls }
      `,
      { cache },
    );
    const after = Date.now();
    expect(r).toEqual({ ok: true, value: { result: 'fresh', calls: 1 } });
    expect(setCalls).toBe(1);
    const stored = store.get('k') as { value: unknown; storedAtMs: number };
    expect(stored.value).toBe('fresh');
    expect(stored.storedAtMs).toBeGreaterThanOrEqual(before);
    expect(stored.storedAtMs).toBeLessThanOrEqual(after);
  });

  it('N-1: a poisoned host-stored entry with storedAtMs slightly in the future (now + 1e6) self-heals as a MISS', async () => {
    const store = new Map<string, unknown>([
      ['k', { value: 'POISON', storedAtMs: Date.now() + 1_000_000 }],
    ]);
    let setCalls = 0;
    const cache = {
      get: async (key: string) => store.get(key) as CacheEntry | undefined,
      set: async (
        key: string,
        entry: { value: unknown; storedAtMs: number },
      ) => {
        setCalls++;
        store.set(key, entry);
      },
    };
    const r = await run(
      `
      local calls = 0
      local function compute() calls = calls + 1; return "fresh" end
      local result = cache.get("k", 3600, compute)
      return { result = result, calls = calls }
      `,
      { cache },
    );
    expect(r).toEqual({ ok: true, value: { result: 'fresh', calls: 1 } });
    expect(setCalls).toBe(1);
    const stored = store.get('k') as { value: unknown; storedAtMs: number };
    expect(stored.value).toBe('fresh');
  });

  it('N-1: a poisoned host-stored entry with a non-integer storedAtMs (123.5) self-heals as a MISS', async () => {
    const store = new Map<string, unknown>([
      ['k', { value: 'POISON', storedAtMs: 123.5 }],
    ]);
    let setCalls = 0;
    const cache = {
      get: async (key: string) => store.get(key) as CacheEntry | undefined,
      set: async (
        key: string,
        entry: { value: unknown; storedAtMs: number },
      ) => {
        setCalls++;
        store.set(key, entry);
      },
    };
    const r = await run(
      `
      local calls = 0
      local function compute() calls = calls + 1; return "fresh" end
      local result = cache.get("k", 3600, compute)
      return { result = result, calls = calls }
      `,
      { cache },
    );
    expect(r).toEqual({ ok: true, value: { result: 'fresh', calls: 1 } });
    expect(setCalls).toBe(1);
    const stored = store.get('k') as { value: unknown; storedAtMs: number };
    expect(stored.value).toBe('fresh');
  });

  it('N-1: a poisoned host-stored entry with a negative storedAtMs self-heals as a MISS', async () => {
    const store = new Map<string, unknown>([
      ['k', { value: 'POISON', storedAtMs: -1 }],
    ]);
    let setCalls = 0;
    const cache = {
      get: async (key: string) => store.get(key) as CacheEntry | undefined,
      set: async (
        key: string,
        entry: { value: unknown; storedAtMs: number },
      ) => {
        setCalls++;
        store.set(key, entry);
      },
    };
    const r = await run(
      `
      local calls = 0
      local function compute() calls = calls + 1; return "fresh" end
      local result = cache.get("k", 3600, compute)
      return { result = result, calls = calls }
      `,
      { cache },
    );
    expect(r).toEqual({ ok: true, value: { result: 'fresh', calls: 1 } });
    expect(setCalls).toBe(1);
    const stored = store.get('k') as { value: unknown; storedAtMs: number };
    expect(stored.value).toBe('fresh');
  });

  it('N-1 boundary: storedAtMs === now (as seen by the same call) is a valid, plausible entry and is served as a HIT (fn never called)', async () => {
    const now = Date.now();
    const store = new Map<string, unknown>([
      ['k', { value: 'good', storedAtMs: now }],
    ]);
    const cache = {
      get: async (key: string) => store.get(key) as CacheEntry | undefined,
      set: async () => {
        throw new Error('should not be called: entry is fresh');
      },
    };
    const r = await run(
      `
      local calls = 0
      local function compute() calls = calls + 1; return "fresh" end
      local result = cache.get("k", 3600, compute)
      return { result = result, calls = calls }
      `,
      { cache },
    );
    expect(r).toEqual({ ok: true, value: { result: 'good', calls: 0 } });
  });

  it('D1: rebinding __smd_marshal_root before a later cache.get call does not bypass the write-side cap', async () => {
    const store = new Map<string, { value: unknown; storedAtMs: number }>();
    const cache = {
      get: async (key: string) => store.get(key),
      set: async (
        key: string,
        entry: { value: unknown; storedAtMs: number },
      ) => {
        store.set(key, entry);
      },
    };
    const r = await run(
      `
      __smd_marshal_root = function(v) return v end
      local t = {}
      for i = 1, 50 do t[i] = i end
      local ok, err = pcall(cache.get, "k", 60, function() return t end)
      return { ok = ok, has_nodes = string.find(tostring(err), "node") ~= nil }
      `,
      { cache, marshalLimits: { maxDepth: 32, maxNodes: 10 } },
    );
    expect(r).toEqual({ ok: true, value: { ok: false, has_nodes: true } });
  });

  it("A1: rebinding error/string/table/math/tonumber does not disable __smd_json_decode's own internal depth guard", async () => {
    let body = '0';
    for (let i = 0; i < 40; i++) body = `{"n": ${body}}`;
    const r = await run(
      `
      error = function() end
      string = nil
      table = nil
      math = nil
      tonumber = nil
      local ok = pcall(__smd_json_decode, ${JSON.stringify(body)})
      return { ok = ok }
      `,
      {
        net: { get: async () => ({ status: 200, body: '{}' }) },
        netGrants: { get: ['api.example.com'], post: [] },
      },
    );
    expect(r).toEqual({ ok: true, value: { ok: false } });
  });

  it('A2: rebinding __smd_json_decode before a later net.fetch_json call does not affect fetch_json', async () => {
    const r = await run(
      `
      __smd_json_decode = function(t) return "TAMPERED" end
      return net.fetch_json("https://api.example.com/x").ok
      `,
      {
        net: { get: async () => ({ status: 200, body: '{"ok": true}' }) },
        netGrants: { get: ['api.example.com'], post: [] },
      },
    );
    expect(r).toEqual({ ok: true, value: true });
  });

  it('C2: a JSON null inside an ARRAY position decodes to Lua false (preserving sequential length); an object null value still stays absent', async () => {
    const r = await run(
      `
      local data = net.fetch_json("https://api.example.com/x")
      return {
        len = #data.arr,
        second_is_false = data.arr[2] == false,
        arr = data.arr,
        obj_field_absent = data.obj.wiki == nil,
      }
      `,
      {
        net: {
          get: async () => ({
            status: 200,
            body: '{"arr": [1, null, 3], "obj": {"name": "x", "wiki": null}}',
          }),
        },
        netGrants: { get: ['api.example.com'], post: [] },
      },
    );
    expect(r).toEqual({
      ok: true,
      value: {
        len: 3,
        second_is_false: true,
        arr: [1, false, 3],
        obj_field_absent: true,
      },
    });
  });
});
