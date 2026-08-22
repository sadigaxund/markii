import { ScriptCapabilityError } from './errors.js';
import { isWriteAllowed } from './paths.js';
import type { BundleFsGrant } from './paths.js';
import type { BundleManifest, BundlePermissions } from './manifest.js';
import type { BundleStorage } from './storage.js';

/**
 * The capability-restricted view of a bundle a future Lua runtime (§8, §10,
 * §11) will actually receive — never the raw `BundleStorage`. Deliberately
 * exposes only `read` / `write` / `exists`, no `list`: directory
 * enumeration stays host-side. An untrusted script that can already read
 * `assets/photo.png` by name doesn't need the ability to *discover* every
 * other file in the bundle; keeping `list` off the script-facing surface
 * minimizes what a script can learn about a bundle it wasn't specifically
 * pointed at (e.g. other cached datasets, other scripts' outputs).
 */
export interface ScriptView {
  read(path: string): Promise<Uint8Array | undefined>;
  write(path: string, data: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
}

/**
 * The fully-trusted convenience case: grants a `ScriptView` exactly what
 * `manifest.permissions` *declares*, nothing more. This is a legitimate
 * pattern for a note the user has already explicitly decided to fully
 * trust (their own note, a dev/test harness) — but it must always be an
 * explicit, named opt-in at the call site, never `createScriptView`'s
 * default. See the DEFECT-10 note on `createScriptView` for why: an
 * untrusted `.mkz` bundle (or its legacy `.mkbundle` counterpart) opened
 * from elsewhere must never be able to grant itself capabilities merely by
 * declaring them in its own manifest.
 */
export function grantAllDeclaredPermissions(
  manifest: BundleManifest,
): BundlePermissions {
  return manifest.permissions ?? {};
}

/**
 * Builds a `ScriptView` over `storage`.
 *
 * DEFECT 10 / spec §10: "Capabilities are declared in the manifest, granted
 * by the user" — declaring is not granting. `manifest.permissions` is
 * whatever the (possibly untrusted) `.mkz` bundle *asks for*; `grantedPermissions`
 * is whatever the user has actually *approved* for this note (e.g. via a
 * permission-prompt UI, remembered per note and re-prompted if scripts
 * change — see §10). The capability this view actually exposes is the
 * INTERSECTION of the two: the manifest can only ever narrow what the user
 * granted, never expand it, and the user's grant can only ever narrow what
 * the manifest declared wanting. Neither side alone is authoritative.
 *
 * `grantedPermissions` defaults to `{}` (zero grants) — deliberately not to
 * "everything the manifest asks for". An untrusted note opened from
 * elsewhere must start with zero grants and still render fully (§10); a
 * caller that wants the old fully-trusted behavior must opt in explicitly,
 * e.g. `createScriptView(storage, manifest, grantAllDeclaredPermissions(manifest))`.
 *
 * - No effective bundle grants at all: every call throws `ScriptCapabilityError`.
 * - `'read'` in the intersection: `read`/`exists` work bundle-wide; `write` still fails.
 * - `'write:cache/'` in the intersection: `write` works, but only for paths
 *   `isWriteAllowed` accepts — `cache/` only. Critically, this holds even
 *   if both the manifest and the granted set include `'write:cache/'` and
 *   the script asks for `manifest.json` or `note.mk.md`: `isWriteAllowed`
 *   denies those two paths unconditionally, regardless of what's granted
 *   or declared (see `./paths`).
 */
export function createScriptView(
  storage: BundleStorage,
  manifest: BundleManifest,
  grantedPermissions: BundlePermissions = {},
): ScriptView {
  const declared = new Set<BundleFsGrant>(manifest.permissions?.bundle ?? []);
  const granted = grantedPermissions.bundle ?? [];
  // Effective capability = declared ∩ granted. See the doc comment above —
  // this is the load-bearing line for DEFECT 10.
  const grants = granted.filter((grant) => declared.has(grant));
  const canRead = grants.includes('read');

  return {
    async read(path) {
      if (!canRead) {
        throw new ScriptCapabilityError(
          `script has no "read" bundle permission (requested "${path}")`,
        );
      }
      return storage.read(path);
    },
    async write(path, data) {
      if (!isWriteAllowed(path, { grants })) {
        throw new ScriptCapabilityError(`script may not write "${path}"`);
      }
      await storage.write(path, data);
    },
    async exists(path) {
      if (!canRead) {
        throw new ScriptCapabilityError(
          `script has no "read" bundle permission (requested "${path}")`,
        );
      }
      return storage.exists(path);
    },
  };
}
