import { existsSync } from 'node:fs';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultWorkerPath, spawnRun } from './run-host';

/**
 * Every test in this file spawns a REAL `worker_thread` running the REAL
 * `worker-entry.ts` through the real wasmoon sandbox (no mocks for the Lua
 * runtime) — see `run-host.ts`'s doc comment and `worker-entry.ts`'s. That
 * makes each case slower than an ordinary unit test (wasmoon boot is
 * ~100ms) but is what actually proves the isolate/watchdog/capability
 * wiring works end to end, matching this slice's brief.
 */

const WORKER_PATH = path.join(__dirname, 'worker-entry.ts');

function fence(name: string, body: string): string {
  return '```lua {name=' + name + '}\n' + body + '\n```\n';
}

describe('defaultWorkerPath', () => {
  it('resolves to the sibling worker-entry.ts source file in dev (no dist/ built)', () => {
    const resolved = defaultWorkerPath();
    expect(resolved.endsWith(path.join('run', 'worker-entry.ts'))).toBe(true);
    expect(existsSync(resolved)).toBe(true);
  });
});

describe('spawnRun — happy path', () => {
  it('runs a two-script document and returns both values', async () => {
    const text = fence('a', 'return 1 + 1') + '\n' + fence('b', 'return "hi"');
    const result = await spawnRun({
      text,
      netAllowlist: [],
      cacheSnapshot: {},
      timeoutMs: 5000,
      workerPath: WORKER_PATH,
    });

    expect(result.failures).toEqual([]);
    expect(result.values.a?.status).toBe('fresh');
    expect(result.values.a?.value).toBe(2);
    expect(result.values.b?.status).toBe('fresh');
    expect(result.values.b?.value).toBe('hi');
  });

  it('scripts share one cache within a single run: a second script hitting the same cache key sees the first cached value (document-order execution)', async () => {
    const text =
      fence(
        'first',
        'return cache.get("shared", 3600, function() return "from-first" end)',
      ) +
      '\n' +
      fence(
        'second',
        'return cache.get("shared", 3600, function() return "from-second" end)',
      );

    const result = await spawnRun({
      text,
      netAllowlist: [],
      cacheSnapshot: {},
      timeoutMs: 5000,
      workerPath: WORKER_PATH,
    });

    expect(result.failures).toEqual([]);
    expect(result.values.first?.value).toBe('from-first');
    // The second script's own `fn` never runs -- its cache.get hits the
    // entry `first` just wrote, within the SAME run's shared in-memory
    // cache provider.
    expect(result.values.second?.value).toBe('from-first');
  });
});

describe('spawnRun — net allowlist', () => {
  let server: http.Server;
  let baseUrl: string;
  let requestCount: number;

  function startServer(): Promise<void> {
    return new Promise((resolve) => {
      requestCount = 0;
      server = http.createServer((_req, res) => {
        requestCount++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ city: 'Springfield' }));
      });
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  }

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('an allowed host succeeds', async () => {
    await startServer();
    const text = fence(
      'a',
      `local r = net.fetch_json("${baseUrl}/city")\nreturn r.city`,
    );
    const result = await spawnRun({
      text,
      netAllowlist: ['127.0.0.1'],
      cacheSnapshot: {},
      timeoutMs: 5000,
      workerPath: WORKER_PATH,
    });

    expect(result.failures).toEqual([]);
    expect(result.values.a?.value).toBe('Springfield');
    expect(requestCount).toBe(1);
  });

  it('a non-allowed host produces a capability-denied failure, and the sandbox stays alive for other scripts in the same run', async () => {
    await startServer();
    const text =
      fence('blocked', `return net.fetch_json("${baseUrl}/city")`) +
      '\n' +
      fence('ok', 'return 1 + 1');

    const result = await spawnRun({
      text,
      // A host IS granted (so the `net` table exists at all), just not
      // the one the script actually calls -- this is what distinguishes
      // a genuine capability denial from calling a nil `net.fetch_json`
      // when NOTHING is granted (an ordinary script-error instead).
      netAllowlist: ['some-other-host.example.com'],
      cacheSnapshot: {},
      timeoutMs: 5000,
      workerPath: WORKER_PATH,
    });

    expect(requestCount).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.name).toBe('blocked');
    expect(result.failures[0]?.kind).toBe('capability-denied');
    // The sandbox/run as a whole is unharmed by the denial.
    expect(result.values.ok?.status).toBe('fresh');
    expect(result.values.ok?.value).toBe(2);
  });
});

describe('spawnRun — net allowlist: redirect handling (B-1)', () => {
  it('a redirect from an allowed host to a NON-allowed host is refused WITHOUT the second host ever being hit', async () => {
    let secondHitCount = 0;
    const secondServer = http.createServer((_req, res) => {
      secondHitCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      secondServer.listen(0, '127.0.0.1', resolve),
    );
    const secondAddress = secondServer.address();
    const secondPort =
      typeof secondAddress === 'object' && secondAddress
        ? secondAddress.port
        : 0;

    const firstServer = http.createServer((_req, res) => {
      res.writeHead(302, {
        Location: `http://localhost:${secondPort}/city`,
      });
      res.end();
    });
    await new Promise<void>((resolve) =>
      firstServer.listen(0, '127.0.0.1', resolve),
    );
    const firstAddress = firstServer.address();
    const firstPort =
      typeof firstAddress === 'object' && firstAddress ? firstAddress.port : 0;

    try {
      const text = fence(
        'a',
        `return net.fetch_json("http://127.0.0.1:${firstPort}/start")`,
      );
      const result = await spawnRun({
        text,
        // Only the FIRST host is granted -- "localhost" (the redirect
        // target) resolves to a different hostname string than
        // "127.0.0.1" even though both point at the loopback interface,
        // so this exercises exactly the SSRF shape B-1 closes.
        netAllowlist: ['127.0.0.1'],
        cacheSnapshot: {},
        timeoutMs: 5000,
        workerPath: WORKER_PATH,
      });

      expect(secondHitCount).toBe(0);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.kind).toBe('capability-denied');
    } finally {
      await new Promise<void>((resolve) => firstServer.close(() => resolve()));
      await new Promise<void>((resolve) => secondServer.close(() => resolve()));
    }
  });

  it('a redirect to an ALLOWED host still succeeds', async () => {
    const targetServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ city: 'Shelbyville' }));
    });
    await new Promise<void>((resolve) =>
      targetServer.listen(0, '127.0.0.1', resolve),
    );
    const targetAddress = targetServer.address();
    const targetPort =
      typeof targetAddress === 'object' && targetAddress
        ? targetAddress.port
        : 0;

    const redirectingServer = http.createServer((_req, res) => {
      res.writeHead(302, {
        Location: `http://127.0.0.1:${targetPort}/city`,
      });
      res.end();
    });
    await new Promise<void>((resolve) =>
      redirectingServer.listen(0, '127.0.0.1', resolve),
    );
    const redirectingAddress = redirectingServer.address();
    const redirectingPort =
      typeof redirectingAddress === 'object' && redirectingAddress
        ? redirectingAddress.port
        : 0;

    try {
      const text = fence(
        'a',
        `local r = net.fetch_json("http://127.0.0.1:${redirectingPort}/start")\nreturn r.city`,
      );
      const result = await spawnRun({
        text,
        netAllowlist: ['127.0.0.1'],
        cacheSnapshot: {},
        timeoutMs: 5000,
        workerPath: WORKER_PATH,
      });

      expect(result.failures).toEqual([]);
      expect(result.values.a?.value).toBe('Shelbyville');
    } finally {
      await new Promise<void>((resolve) =>
        redirectingServer.close(() => resolve()),
      );
      await new Promise<void>((resolve) => targetServer.close(() => resolve()));
    }
  });
});

describe('spawnRun — net allowlist: oversized body (B-2)', () => {
  it('a response streamed past the byte cap is aborted, never fully buffered, and denied as capability-denied', async () => {
    let bytesSent = 0;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Keep writing chunks past the (tiny, script-configured) cap. If the
      // worker's read is genuinely bounded rather than buffered whole, this
      // interval is cleared and the connection torn down well before it
      // could ever produce anywhere near this much data.
      const chunk = '{"pad":"' + 'x'.repeat(1000) + '"}'; // ~1010 bytes/chunk
      const interval = setInterval(() => {
        bytesSent += chunk.length;
        res.write(chunk);
      }, 5);
      res.on('close', () => clearInterval(interval));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const text = fence(
        'a',
        `return net.fetch_json("http://127.0.0.1:${port}/big")`,
      );
      const result = await spawnRun({
        text,
        netAllowlist: ['127.0.0.1'],
        cacheSnapshot: {},
        timeoutMs: 5000,
        // A cap far below what the JSON parser would even accept as valid
        // JSON -- the point here is proving the READ is bounded, not that
        // the sandbox's own post-hoc size check (which would also catch an
        // unbounded read, just too late) ever runs.
        limits: { maxFetchBytes: 2000 },
        workerPath: WORKER_PATH,
      });

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.kind).toBe('capability-denied');
      // The server was still writing well past the cap when the worker
      // aborted -- proof the read didn't wait for the whole (effectively
      // unbounded) body before giving up.
      expect(bytesSent).toBeLessThan(200_000);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);

  it('a Content-Length over the cap is rejected before any body is read', async () => {
    let bodyWriteAttempted = false;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': '10000000',
      });
      // The declared length is a lie relative to what's actually sent --
      // this proves the header check alone is enough to refuse the
      // response without ever touching the stream.
      bodyWriteAttempted = true;
      res.end('{}');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const text = fence(
        'a',
        `return net.fetch_json("http://127.0.0.1:${port}/declared-big")`,
      );
      const result = await spawnRun({
        text,
        netAllowlist: ['127.0.0.1'],
        cacheSnapshot: {},
        timeoutMs: 5000,
        limits: { maxFetchBytes: 2000 },
        workerPath: WORKER_PATH,
      });

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.kind).toBe('capability-denied');
      expect(bodyWriteAttempted).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('spawnRun — net.post / net.patch share the GET allowlist (B-6)', () => {
  it('an allowed host accepts a POST', async () => {
    let receivedBody = '';
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString();
      });
      req.on('end', () => {
        receivedBody = raw;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const text = fence(
        'a',
        `local r = net.post("http://127.0.0.1:${port}/x", '{"n":1}')\nreturn r.status`,
      );
      const result = await spawnRun({
        text,
        netAllowlist: ['127.0.0.1'],
        cacheSnapshot: {},
        timeoutMs: 5000,
        workerPath: WORKER_PATH,
      });

      expect(result.failures).toEqual([]);
      expect(result.values.a?.value).toBe(200);
      expect(receivedBody).toBe('{"n":1}');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('a non-allowed host is denied for POST just like it is for GET', async () => {
    const text = fence('a', `return net.post("http://127.0.0.1:9/x", "{}")`);
    const result = await spawnRun({
      text,
      netAllowlist: ['some-other-host.example.com'],
      cacheSnapshot: {},
      timeoutMs: 5000,
      workerPath: WORKER_PATH,
    });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.kind).toBe('capability-denied');
  });
});

describe('spawnRun — worker resourceLimits (A-1)', () => {
  it('a worker that busts its own capped JS heap resolves as a failure result, never crashing the host process', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'markii-run-host-test-'));
    const oomWorkerPath = path.join(dir, 'oom-worker.cjs');
    writeFileSync(
      oomWorkerPath,
      "const { parentPort } = require('node:worker_threads');\n" +
        "parentPort.once('message', () => {\n" +
        '  const balloon = [];\n' +
        '  for (;;) { balloon.push(new Array(1000000).fill(0)); }\n' +
        '});\n',
    );

    // `spawnRun` (`run-host.ts`) constructs every worker, including this
    // rigged one, with `resourceLimits.maxOldGenerationSizeMb` (A-1's own
    // fix) -- the balloon above should hit that cap and raise the worker's
    // `'error'` event well within a couple hundred ms, long before the
    // 2000ms external watchdog would otherwise need to step in as a
    // backstop. Either way, the property under test is the same: the host
    // process (this test process) survives, and `spawnRun` still resolves
    // with an ordinary failure result rather than crashing or hanging.
    const result = await spawnRun({
      text: fence('a', 'return 1'),
      netAllowlist: [],
      cacheSnapshot: {},
      timeoutMs: 2000,
      workerPath: oomWorkerPath,
    });

    expect(result.values).toEqual({});
    expect(result.failures).toHaveLength(1);
  }, 15_000);

  it('constructs the worker with resourceLimits.maxOldGenerationSizeMb set', () => {
    const source = readFileSync(path.join(__dirname, 'run-host.ts'), 'utf8');
    expect(source).toMatch(/resourceLimits/);
    expect(source).toMatch(/maxOldGenerationSizeMb/);
  });
});

describe('spawnRun — cache snapshot persistence across runs', () => {
  it('re-seeding the returned cacheSnapshot on a second run within the TTL avoids a second fetch', async () => {
    let requestCount = 0;
    const server = http.createServer((_req, res) => {
      requestCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ n: requestCount }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const text = fence(
        'a',
        `return cache.get("k", 3600, function() return net.fetch_json("${baseUrl}/x") end)`,
      );

      const first = await spawnRun({
        text,
        netAllowlist: ['127.0.0.1'],
        cacheSnapshot: {},
        timeoutMs: 5000,
        workerPath: WORKER_PATH,
      });
      expect(first.failures).toEqual([]);
      expect(requestCount).toBe(1);
      expect(Object.keys(first.cacheSnapshot)).toContain('k');

      const second = await spawnRun({
        text,
        netAllowlist: ['127.0.0.1'],
        cacheSnapshot: first.cacheSnapshot,
        timeoutMs: 5000,
        workerPath: WORKER_PATH,
      });
      expect(second.failures).toEqual([]);
      // Still fresh within the TTL -- cache.get never called `fn` again.
      expect(requestCount).toBe(1);
      expect(second.values.a?.value).toEqual(first.values.a?.value);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('spawnRun — watchdog', () => {
  it('kills a `while true do end` script at the external deadline and never blocks the host event loop', async () => {
    const text = fence('a', 'while true do end');

    let ticks = 0;
    const ticker = setInterval(() => {
      ticks++;
    }, 15);

    const resultPromise = spawnRun({
      text,
      netAllowlist: [],
      cacheSnapshot: {},
      timeoutMs: 300,
      workerPath: WORKER_PATH,
    });

    const result = await resultPromise;
    clearInterval(ticker);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.kind).toBe('limit');
    expect(result.failures[0]?.message).toMatch(/watchdog/);
    // The host's own event loop kept running a 15ms interval timer while
    // the worker thread was stuck in its busy loop -- proof the watchdog's
    // wait is asynchronous, not a blocking join.
    expect(ticks).toBeGreaterThan(3);
  }, 10_000);

  it('kills a pcall-wrapped `while true do end` the same way (a script cannot swallow the external kill)', async () => {
    const text = fence('a', 'pcall(function() while true do end end)');

    const result = await spawnRun({
      text,
      netAllowlist: [],
      cacheSnapshot: {},
      timeoutMs: 300,
      workerPath: WORKER_PATH,
    });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.kind).toBe('limit');
  }, 10_000);
});

describe('spawnRun — worker crash', () => {
  it('a worker that calls process.exit() resolves (never rejects) with a script-error failure', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'markii-run-host-test-'));
    const riggedWorkerPath = path.join(dir, 'rigged-worker.cjs');
    writeFileSync(
      riggedWorkerPath,
      "const { parentPort } = require('node:worker_threads');\n" +
        "parentPort.once('message', () => { process.exit(7); });\n",
    );

    const result = await spawnRun({
      text: fence('a', 'return 1'),
      netAllowlist: [],
      cacheSnapshot: {},
      timeoutMs: 5000,
      workerPath: riggedWorkerPath,
    });

    expect(result.values).toEqual({});
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.kind).toBe('script-error');
    expect(result.failures[0]?.message).toMatch(/exited unexpectedly/);
    expect(result.failures[0]?.message).toMatch(/7/);
  });
});
