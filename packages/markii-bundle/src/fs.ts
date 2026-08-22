// Node-only: exported solely via the "./fs" subpath (see package.json),
// mirroring @markii/core's "./corpus" split — a browser bundler resolving
// this package's main entry never has to reason about `node:fs`.
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BundlePathError } from './errors.js';
import { createDefaultManifest, CURRENT_SPEC_VERSION } from './manifest.js';
import type { BundleStorage } from './storage.js';
import { normalizeOrThrow } from './storage.js';
import {
  exportZipBundle,
  openZipBundle,
  type OpenZipBundleOptions,
} from './zip.js';

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function isEnoent(err: unknown): boolean {
  return isErrnoException(err) && err.code === 'ENOENT';
}

/**
 * `ENOTDIR` shows up when an *earlier* path component turns out to be a
 * plain file instead of a directory (e.g. writing `cache/data.json/sub`
 * when `cache/data.json` already exists as a file) — treated the same as
 * "doesn't exist yet" by the lstat walk below, deferring the actual clear
 * error to the subsequent `mkdir`/`writeFile`/`open` call.
 */
function isEnoentLike(err: unknown): boolean {
  return (
    isErrnoException(err) && (err.code === 'ENOENT' || err.code === 'ENOTDIR')
  );
}

/**
 * Resolves `rootAbs/relPath` (both already-safe: `relPath` has passed
 * `normalizeOrThrow`) against the real filesystem, refusing to follow any
 * symlink anywhere along the way — this is the storage-layer half of
 * closing ESCAPE 1/2/3 from the independent security review: the path-jail
 * in `./paths` only reasons about the *logical* path string, but the actual
 * filesystem write/read *follows symlinks*, so a symlink planted anywhere
 * inside the bundle (even one that resolves to somewhere still nominally
 * "inside the bundle root", like `cache/pwn -> ../manifest.json`) can
 * silently retarget an otherwise-innocuous-looking write.
 *
 * Two layers, in order:
 *
 * 1. **Primary defense — lstat every path component.** Walk `relPath`
 *    segment by segment from `rootAbs`, `lstat`-ing each one (never
 *    `stat`, which would itself follow a symlink). The moment any
 *    *existing* component is a symlink — file or directory, leaf or
 *    ancestor, whether or not it resolves inside or outside the root — the
 *    whole operation is rejected. This alone defeats ESCAPE 1 (`cache/pwn`
 *    symlinked to `../manifest.json`) and its directory variant
 *    (`cache/up` symlinked to `..`, then `cache/up/manifest.json` or even
 *    `cache/up/not-yet-created.txt`): the symlinked component is caught
 *    before we ever ask whether its target exists.
 * 2. **Defense in depth — resolved-path re-check.** Once the walk finds
 *    the nearest existing ancestor (the leaf itself may not exist yet,
 *    e.g. a fresh write), that ancestor is symlink-free by construction
 *    (step 1 proved it), so its `realpath` is expected to equal its literal
 *    path exactly. We compute that anyway and assert it — effectively
 *    "re-run the write policy on the resolved path": since resolved path
 *    and logical path are now provably identical, whatever policy check a
 *    caller (e.g. `ScriptView.write`, gated on `isWriteAllowed`) already
 *    ran against the logical path remains valid for what actually gets
 *    touched on disk. A mismatch here (mount points, case-insensitive
 *    filesystems, or a bug in step 1) is rejected rather than trusted.
 *
 * TOCTOU note: there is an unavoidable gap between this check and the
 * `open`/`readFile`/`writeFile` call that follows it (and a second, smaller
 * gap inside `write` between opening the file and hard-link-checking it —
 * see there). Closing that gap completely would require doing everything
 * through `O_NOFOLLOW`-opened file descriptors end-to-end, which Node's
 * high-level `fs/promises` API does not expose uniformly across platforms.
 * The threat model here is a *hostile script running inside this process*
 * (§10) manipulating the bundle's own files between our checks — not a
 * concurrent, privileged local-filesystem attacker racing the filesystem
 * from *outside* the process, which is out of scope (same assumption the
 * rest of this package makes: a bundle's own directory isn't being
 * concurrently rewritten by an unrelated actor while we operate on it).
 *
 * Returns the plain (non-realpath) `rootAbs`-joined path for the caller to
 * actually operate on, plus whether a filesystem entry currently exists at
 * that path (so `write` can decide between "fresh file" and "must check
 * hard-link count before touching an existing one").
 */
async function resolveInsideRoot(
  rootAbs: string,
  relPath: string,
): Promise<{ target: string; exists: boolean }> {
  const rootReal = await realpath(rootAbs);
  const segments = relPath.split('/');

  let current = rootAbs;
  let consumed = 0;
  for (; consumed < segments.length; consumed++) {
    const segment = segments[consumed] as string;
    const next = join(current, segment);
    let st;
    try {
      st = await lstat(next);
    } catch (err) {
      if (isEnoentLike(err)) break;
      throw err;
    }
    if (st.isSymbolicLink()) {
      throw new BundlePathError(
        relPath,
        `path component ${JSON.stringify(segments.slice(0, consumed + 1).join('/'))} is a symlink — symlinks inside a bundle are never followed`,
      );
    }
    current = next;
  }

  const exists = consumed === segments.length;

  // Defense-in-depth resolved-path re-check (see doc comment above).
  const existingReal = current === rootAbs ? rootReal : await realpath(current);
  const rel = relative(rootReal, existingReal);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new BundlePathError(relPath, 'resolved path escapes the bundle root');
  }
  const relNormalized = rel.length === 0 ? '' : rel.split(sep).join('/');
  const expectedPrefix = segments.slice(0, consumed).join('/');
  if (relNormalized !== expectedPrefix) {
    throw new BundlePathError(
      relPath,
      'resolved path does not match the requested bundle-relative path (possible symlink or mount-point redirection)',
    );
  }

  return { target: join(rootAbs, relPath), exists };
}

/**
 * Writes `data` to an already symlink-checked `target` that is known to
 * exist, refusing to write through a hard link (ESCAPE 3: `st_nlink > 1`
 * means some other path — possibly outside the bundle entirely, e.g.
 * `ln b.mkz/../victim.txt b.mkz/cache/hard` — refers to the exact same
 * inode, so writing here would also silently modify that other path).
 *
 * Opens the file first *without* truncating (`'r+'`), `fstat`s the open
 * file descriptor (not a separate `stat(path)` call — checking the fd
 * avoids a second TOCTOU window between "check nlink" and "open the file
 * we checked"), and only truncates + writes once the link count is
 * confirmed to be exactly 1.
 */
async function writeExistingFileNoHardlink(
  target: string,
  relPath: string,
  data: Uint8Array,
): Promise<void> {
  const handle = await open(target, 'r+');
  try {
    const st = await handle.stat();
    if (st.nlink > 1) {
      throw new BundlePathError(
        relPath,
        `refusing to write through a hard-linked file (${st.nlink} links) — writing would also modify the other link target(s)`,
      );
    }
    await handle.truncate(0);
    if (data.length > 0) {
      await handle.write(data, 0, data.length, 0);
    }
  } finally {
    await handle.close();
  }
}

/**
 * Opens the directory form of a bundle: reads/writes go straight to disk
 * under `rootDir`, with every operation re-verified against symlink escape
 * (see `resolveInsideRoot`) and, on write, against hard-link aliasing (see
 * `writeExistingFileNoHardlink`). `rootDir` must already exist.
 */
export function openDirBundle(rootDir: string): BundleStorage {
  const rootAbs = resolve(rootDir);

  return {
    async read(path) {
      const relPath = normalizeOrThrow(path);
      const { target } = await resolveInsideRoot(rootAbs, relPath);
      try {
        const buf = await readFile(target);
        // `readFile` resolves a Node `Buffer` (a `Uint8Array` subclass).
        // Re-view it as a plain `Uint8Array` so callers get the type this
        // interface promises, not an implementation detail that happens to
        // compare unequal to a literal `Uint8Array` under deep-equality.
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      } catch (err) {
        if (isEnoent(err)) return undefined;
        throw err;
      }
    },
    async write(path, data) {
      const relPath = normalizeOrThrow(path);
      const { target, exists } = await resolveInsideRoot(rootAbs, relPath);
      if (exists) {
        await writeExistingFileNoHardlink(target, relPath, data);
        return;
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    },
    async list() {
      const results: string[] = [];
      const walk = async (dirAbs: string, prefix: string): Promise<void> => {
        const entries = await readdir(dirAbs, { withFileTypes: true });
        for (const entry of entries) {
          // Never follow symlinked entries during enumeration: a symlink
          // planted inside the bundle dir could otherwise leak the
          // directory structure (or contents) of wherever it points.
          if (entry.isSymbolicLink()) continue;
          const entryRelPath = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            await walk(join(dirAbs, entry.name), entryRelPath);
          } else if (entry.isFile()) {
            results.push(entryRelPath);
          }
        }
      };
      await walk(rootAbs, '');
      return results.sort();
    },
    async exists(path) {
      const relPath = normalizeOrThrow(path);
      const { target } = await resolveInsideRoot(rootAbs, relPath);
      try {
        const info = await stat(target);
        return info.isFile();
      } catch (err) {
        if (isEnoent(err)) return false;
        throw err;
      }
    },
  };
}

/**
 * Scaffolds a brand-new bundle directory: `dir/note.mk.md` with `smdText` as
 * its content, plus a default `dir/manifest.json` (no permissions granted,
 * no packs declared). Creates `dir` if it doesn't already exist.
 */
export async function promoteToBundle(
  smdText: string,
  dir: string,
  specVersion: string = CURRENT_SPEC_VERSION,
): Promise<void> {
  const dirAbs = resolve(dir);
  await mkdir(dirAbs, { recursive: true });
  await writeFile(join(dirAbs, 'note.mk.md'), smdText, 'utf8');
  const manifest = createDefaultManifest(specVersion);
  await writeFile(
    join(dirAbs, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

/** Zips up an existing bundle directory. Reuses `openDirBundle` + `exportZipBundle` from `./zip`. */
export async function dirToZip(rootDir: string): Promise<Uint8Array> {
  return exportZipBundle(openDirBundle(rootDir));
}

/**
 * Extracts a zip bundle into `destDir` (created if missing). Inherits
 * `openZipBundle`'s zip-slip/collision/decompression-bomb/CRC rejection —
 * a tampered or malformed zip throws `BundleZipError` before anything is
 * written to disk. `options` is forwarded to `openZipBundle` (see there for
 * the decompression-size-budget knobs).
 */
export async function zipToDir(
  bytes: Uint8Array,
  destDir: string,
  options?: OpenZipBundleOptions,
): Promise<void> {
  const src = openZipBundle(bytes, options); // throws BundleZipError on unsafe/oversized/corrupt entries
  await mkdir(resolve(destDir), { recursive: true });
  const dest = openDirBundle(destDir);
  for (const path of await src.list()) {
    const data = await src.read(path);
    if (data !== undefined) await dest.write(path, data);
  }
}
