import type {
  CacheEntry,
  CacheProvider,
  NetGrants,
  NetProvider,
  NetResponse,
} from '@markii/lua';

/**
 * The playground's host-side implementations of `@markii/lua`'s capability
 * interfaces (docs/scripting.md/§10/§11). The Lua sandbox has no ambient network
 * or storage of its own by design — the host injects these. This is a *dev
 * harness* implementation: a real app would route `net.get` through its own
 * SSRF/allowlist policy surface and back `cache` with durable bundle
 * storage (`.mkz/cache/`, spec §9/§11); here, a plain browser `fetch`
 * and an in-memory `Map` are enough to make the Run flow real.
 */

/**
 * Real browser `fetch`, mapped to `@markii/lua`'s `NetResponse` shape
 * (`{ status: number; body: string }` — see `capabilities.ts`). A network
 * failure (DNS, CORS, offline) makes `fetch` itself reject; that rejection
 * is left to propagate as-is (wrapped with the URL for context) rather than
 * synthesized into a fake `NetResponse`, so it surfaces through
 * `buildCapabilities`'s existing error path exactly like any other thrown
 * error from a host capability (`@markii/lua`'s `sandbox.ts` classifies it
 * as an ordinary `'runtime'` failure). A non-2xx HTTP response is NOT an
 * error here — it is a normal `NetResponse` with that status code; the
 * script (or `net.fetch_json`'s JSON-parse step) decides what to do with it.
 */
export function createFetchNetProvider(): NetProvider {
  return {
    async get(url: string): Promise<NetResponse> {
      let response: Response;
      try {
        response = await fetch(url);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`fetch failed for "${url}": ${message}`);
      }
      const body = await response.text();
      return { status: response.status, body };
    },
  };
}

/** GitHub's REST API sends CORS headers and works unauthenticated for the demo's read-only `net.fetch_json` call. */
export const DEMO_NET_GRANTS: NetGrants = {
  get: ['api.github.com', 'api.open-meteo.com'],
  post: [],
};

/**
 * Simple in-memory `CacheProvider` (`@markii/lua`'s `cache.get(key, ttl,
 * fn)` backing store) — a `Map<string, CacheEntry>` scoped to one session.
 * Fine for a demo; a real host would persist this into the bundle's
 * `cache/` (spec §9/§11) so it survives a reload.
 */
export function createMemoryCacheProvider(): CacheProvider {
  const entries = new Map<string, CacheEntry>();
  return {
    async get(key: string): Promise<CacheEntry | undefined> {
      return entries.get(key);
    },
    async set(key: string, entry: CacheEntry): Promise<void> {
      entries.set(key, entry);
    },
  };
}
