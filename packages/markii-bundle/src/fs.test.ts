import { zipSync } from 'fflate';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BundlePathError } from './errors';
import { dirToZip, openDirBundle, promoteToBundle, zipToDir } from './fs';
import { createScriptView } from './script-view';

function u8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

const tmpDirs: string[] = [];

async function makeTmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('openDirBundle — happy path', () => {
  it('writes and reads a file', async () => {
    const dir = await makeTmpDir('markii-bundle-fs-');
    const storage = openDirBundle(dir);
    await storage.write('cache/data.json', u8('{"ok":true}'));
    expect(await storage.read('cache/data.json')).toEqual(u8('{"ok":true}'));
    expect(await readFile(join(dir, 'cache', 'data.json'), 'utf8')).toBe(
      '{"ok":true}',
    );
  });

  it('returns undefined for a missing file', async () => {
    const dir = await makeTmpDir('markii-bundle-fs-');
    const storage = openDirBundle(dir);
    expect(await storage.read('nope.txt')).toBeUndefined();
  });

  it('reports exists correctly', async () => {
    const dir = await makeTmpDir('markii-bundle-fs-');
    const storage = openDirBundle(dir);
    await storage.write('assets/a.txt', u8('a'));
    expect(await storage.exists('assets/a.txt')).toBe(true);
    expect(await storage.exists('assets/b.txt')).toBe(false);
  });

  it('lists all files recursively, sorted, bundle-relative', async () => {
    const dir = await makeTmpDir('markii-bundle-fs-');
    const storage = openDirBundle(dir);
    await storage.write('note.mk.md', u8('# hi'));
    await storage.write('assets/photo.png', u8('img'));
    await storage.write('cache/nested/deep.json', u8('{}'));
    expect(await storage.list()).toEqual([
      'assets/photo.png',
      'cache/nested/deep.json',
      'note.mk.md',
    ]);
  });

  it('creates missing intermediate directories on write', async () => {
    const dir = await makeTmpDir('markii-bundle-fs-');
    const storage = openDirBundle(dir);
    await storage.write('a/b/c/d.txt', u8('deep'));
    expect(await storage.read('a/b/c/d.txt')).toEqual(u8('deep'));
  });
});

describe('openDirBundle — path-jail enforcement', () => {
  it('throws BundlePathError for a traversal path on write', async () => {
    const dir = await makeTmpDir('markii-bundle-fs-');
    const storage = openDirBundle(dir);
    await expect(storage.write('../evil.txt', u8('x'))).rejects.toThrow(
      BundlePathError,
    );
  });

  it('throws BundlePathError for a traversal path on read', async () => {
    const dir = await makeTmpDir('markii-bundle-fs-');
    const storage = openDirBundle(dir);
    await expect(storage.read('../../etc/passwd')).rejects.toThrow(
      BundlePathError,
    );
  });
});

describe('openDirBundle — symlink escape', () => {
  it('rejects reads/writes through a symlink planted inside the bundle pointing outside it', async ({
    skip,
  }) => {
    const outsideDir = await makeTmpDir('markii-bundle-fs-outside-');
    const secretPath = join(outsideDir, 'secret.txt');
    await writeFile(secretPath, 'outside-the-bundle', 'utf8');

    const bundleDir = await makeTmpDir('markii-bundle-fs-bundle-');
    const linkPath = join(bundleDir, 'escape-link');

    try {
      await symlink(secretPath, linkPath, 'file');
    } catch {
      // Platform/user lacks permission to create symlinks (common in
      // sandboxed CI or on Windows without dev mode) — skip cleanly rather
      // than failing the suite for an environment limitation.
      skip();
      return;
    }

    const storage = openDirBundle(bundleDir);
    await expect(storage.read('escape-link')).rejects.toThrow(BundlePathError);
    await expect(
      storage.write('escape-link', u8('overwritten')),
    ).rejects.toThrow(BundlePathError);

    // The file outside the bundle must be untouched.
    expect(await readFile(secretPath, 'utf8')).toBe('outside-the-bundle');
  });

  it('rejects writes through a symlinked directory inside the bundle', async ({
    skip,
  }) => {
    const outsideDir = await makeTmpDir('markii-bundle-fs-outside-');
    const bundleDir = await makeTmpDir('markii-bundle-fs-bundle-');
    const linkDirPath = join(bundleDir, 'cache');

    try {
      await symlink(outsideDir, linkDirPath, 'dir');
    } catch {
      skip();
      return;
    }

    const storage = openDirBundle(bundleDir);
    await expect(
      storage.write('cache/new-file.json', u8('{}')),
    ).rejects.toThrow(BundlePathError);

    // Nothing should have been written into the outside directory.
    const outsideStorage = openDirBundle(outsideDir);
    expect(await outsideStorage.exists('new-file.json')).toBe(false);
  });
});

describe('openDirBundle — ESCAPE 1/2: symlink inside cache/ re-targeting a forbidden in-bundle path', () => {
  it('a symlink at cache/pwn -> ../manifest.json is rejected outright, manifest.json untouched', async ({
    skip,
  }) => {
    const bundleDir = await makeTmpDir('markii-bundle-escape1-');
    await mkdir(join(bundleDir, 'cache'), { recursive: true });
    await writeFile(
      join(bundleDir, 'manifest.json'),
      '{"mark":"0.1.0"}',
      'utf8',
    );
    await writeFile(join(bundleDir, 'note.mk.md'), '# original', 'utf8');

    try {
      await symlink('../manifest.json', join(bundleDir, 'cache', 'pwn'));
    } catch {
      skip();
      return;
    }

    const storage = openDirBundle(bundleDir);
    const view = createScriptView(
      storage,
      { mark: '0.1.0', permissions: { bundle: ['write:cache/'] } },
      { bundle: ['write:cache/'] },
    );

    await expect(
      view.write(
        'cache/pwn',
        u8('{"mark":"9.9.9","permissions":{"bundle":["read","write:cache/"]}}'),
      ),
    ).rejects.toThrow();

    expect(await readFile(join(bundleDir, 'manifest.json'), 'utf8')).toBe(
      '{"mark":"0.1.0"}',
    );
  });

  it('a symlink at cache/pwn-note -> ../note.mk.md is rejected outright, note.mk.md untouched (ESCAPE 2)', async ({
    skip,
  }) => {
    const bundleDir = await makeTmpDir('markii-bundle-escape2-');
    await mkdir(join(bundleDir, 'cache'), { recursive: true });
    await writeFile(
      join(bundleDir, 'manifest.json'),
      '{"mark":"0.1.0"}',
      'utf8',
    );
    await writeFile(join(bundleDir, 'note.mk.md'), '# original', 'utf8');

    try {
      await symlink('../note.mk.md', join(bundleDir, 'cache', 'pwn-note'));
    } catch {
      skip();
      return;
    }

    const storage = openDirBundle(bundleDir);
    const view = createScriptView(
      storage,
      { mark: '0.1.0', permissions: { bundle: ['write:cache/'] } },
      { bundle: ['write:cache/'] },
    );

    await expect(
      view.write('cache/pwn-note', u8('# hacked, self-modifying document')),
    ).rejects.toThrow();

    expect(await readFile(join(bundleDir, 'note.mk.md'), 'utf8')).toBe(
      '# original',
    );
  });

  it('a symlinked directory (cache/up -> ..) is rejected even reaching an EXISTING file (manifest.json / note.mk.md)', async ({
    skip,
  }) => {
    const bundleDir = await makeTmpDir('markii-bundle-escape1dir-');
    await mkdir(join(bundleDir, 'cache'), { recursive: true });
    await writeFile(
      join(bundleDir, 'manifest.json'),
      '{"mark":"0.1.0"}',
      'utf8',
    );
    await writeFile(join(bundleDir, 'note.mk.md'), '# original', 'utf8');

    try {
      await symlink('..', join(bundleDir, 'cache', 'up'));
    } catch {
      skip();
      return;
    }

    const storage = openDirBundle(bundleDir);
    await expect(
      storage.write('cache/up/manifest.json', u8('{"mark":"9.9.9"}')),
    ).rejects.toThrow(BundlePathError);
    await expect(
      storage.write('cache/up/note.mk.md', u8('# hacked')),
    ).rejects.toThrow(BundlePathError);

    expect(await readFile(join(bundleDir, 'manifest.json'), 'utf8')).toBe(
      '{"mark":"0.1.0"}',
    );
    expect(await readFile(join(bundleDir, 'note.mk.md'), 'utf8')).toBe(
      '# original',
    );
  });

  it('a symlinked directory (cache/up -> ..) is rejected even when the leaf under it does not exist yet', async ({
    skip,
  }) => {
    const bundleDir = await makeTmpDir('markii-bundle-escape1dir2-');
    await mkdir(join(bundleDir, 'cache'), { recursive: true });

    try {
      await symlink('..', join(bundleDir, 'cache', 'up'));
    } catch {
      skip();
      return;
    }

    const storage = openDirBundle(bundleDir);
    // "brand-new-file.txt" does not exist anywhere yet — only the parent
    // component ("cache/up") is a symlink. Must still be rejected.
    await expect(
      storage.write('cache/up/brand-new-file.txt', u8('pwned')),
    ).rejects.toThrow(BundlePathError);

    const escapedPath = join(bundleDir, 'brand-new-file.txt');
    await expect(readFile(escapedPath)).rejects.toThrow();
  });
});

describe('openDirBundle — ESCAPE 3: hard links defeat the root boundary', () => {
  it('rejects a write through a hard link that points outside the bundle root, victim file untouched', async ({
    skip,
  }) => {
    const parent = await makeTmpDir('markii-bundle-escape3-parent-');
    const bundleDir = join(parent, 'b.mkz');
    await mkdir(join(bundleDir, 'cache'), { recursive: true });
    const victimPath = join(parent, 'victim.txt');
    await writeFile(victimPath, 'original victim content', 'utf8');

    try {
      await link(victimPath, join(bundleDir, 'cache', 'hard'));
    } catch {
      skip();
      return;
    }

    const storage = openDirBundle(bundleDir);
    await expect(
      storage.write('cache/hard', u8('overwritten via hardlink')),
    ).rejects.toThrow(BundlePathError);

    expect(await readFile(victimPath, 'utf8')).toBe('original victim content');
  });

  it('rejects a write through a hard link that aliases manifest.json, manifest.json untouched', async ({
    skip,
  }) => {
    const bundleDir = await makeTmpDir('markii-bundle-escape3-manifest-');
    await mkdir(join(bundleDir, 'cache'), { recursive: true });
    await writeFile(
      join(bundleDir, 'manifest.json'),
      '{"mark":"0.1.0"}',
      'utf8',
    );

    try {
      await link(
        join(bundleDir, 'manifest.json'),
        join(bundleDir, 'cache', 'mhard'),
      );
    } catch {
      skip();
      return;
    }

    const storage = openDirBundle(bundleDir);
    await expect(
      storage.write('cache/mhard', u8('{"mark":"9.9.9"}')),
    ).rejects.toThrow(BundlePathError);

    expect(await readFile(join(bundleDir, 'manifest.json'), 'utf8')).toBe(
      '{"mark":"0.1.0"}',
    );
  });

  it('a normal (non-hardlinked) file can still be overwritten (nlink === 1 remains the happy path)', async () => {
    const dir = await makeTmpDir('markii-bundle-escape3-happy-');
    const storage = openDirBundle(dir);
    await storage.write('cache/plain.json', u8('{"v":1}'));
    await storage.write('cache/plain.json', u8('{"v":2}'));
    expect(await storage.read('cache/plain.json')).toEqual(u8('{"v":2}'));
  });
});

describe('promoteToBundle', () => {
  it('scaffolds note.mk.md and manifest.json', async () => {
    const dir = await makeTmpDir('markii-bundle-fs-');
    const targetDir = join(dir, 'my-note.mkz');
    await promoteToBundle('# My Note\n\nHello.', targetDir, '0.1.0');

    expect(await readFile(join(targetDir, 'note.mk.md'), 'utf8')).toBe(
      '# My Note\n\nHello.',
    );
    const manifestRaw = await readFile(
      join(targetDir, 'manifest.json'),
      'utf8',
    );
    expect(JSON.parse(manifestRaw)).toEqual({ mark: '0.1.0' });
  });

  it('works identically under a legacy .mkbundle directory name', async () => {
    // The directory storage form never inspects its own path's extension —
    // .mkz is the name new tooling writes, but a directory that still ends
    // in the legacy .mkbundle keeps working exactly the same way.
    const dir = await makeTmpDir('markii-bundle-fs-legacy-');
    const targetDir = join(dir, 'my-note.mkbundle');
    await promoteToBundle('# My Note\n\nHello.', targetDir, '0.1.0');

    expect(await readFile(join(targetDir, 'note.mk.md'), 'utf8')).toBe(
      '# My Note\n\nHello.',
    );
    const manifestRaw = await readFile(
      join(targetDir, 'manifest.json'),
      'utf8',
    );
    expect(JSON.parse(manifestRaw)).toEqual({ mark: '0.1.0' });
  });
});

describe('dir <-> zip round-trip', () => {
  it('produces an identical file tree after dir -> zip -> dir', async () => {
    const srcDir = await makeTmpDir('markii-bundle-fs-src-');
    await mkdir(join(srcDir, 'assets'), { recursive: true });
    await mkdir(join(srcDir, 'cache', 'nested'), { recursive: true });
    await writeFile(join(srcDir, 'note.mk.md'), '# roundtrip\n', 'utf8');
    await writeFile(join(srcDir, 'manifest.json'), '{"mark":"0.1.0"}', 'utf8');
    await writeFile(
      join(srcDir, 'assets', 'photo.png'),
      Buffer.from([1, 2, 3, 4]),
    );
    await writeFile(
      join(srcDir, 'cache', 'nested', 'deep.json'),
      '{"n":1}',
      'utf8',
    );

    const zipBytes = await dirToZip(srcDir);

    const destDir = await makeTmpDir('markii-bundle-fs-dest-');
    await zipToDir(zipBytes, join(destDir, 'extracted'));
    const extractedDir = join(destDir, 'extracted');

    const srcStorage = openDirBundle(srcDir);
    const destStorage = openDirBundle(extractedDir);

    const srcList = await srcStorage.list();
    const destList = await destStorage.list();
    expect(destList).toEqual(srcList);

    for (const path of srcList) {
      expect(await destStorage.read(path)).toEqual(await srcStorage.read(path));
    }
  });

  it('zipToDir rejects a zip-slip archive before writing anything', async () => {
    // A minimal malicious archive: one entry with a `../` traversal name,
    // built with the same fflate primitive `zip.ts` uses. Exercises
    // zipToDir's inherited zip-slip rejection (openZipBundle's own
    // dedicated coverage lives in zip.test.ts).
    const bytes = zipSync({ '../evil.txt': new TextEncoder().encode('pwned') });
    const destDir = await makeTmpDir('markii-bundle-fs-dest-');
    const targetDir = join(destDir, 'extracted');
    await expect(zipToDir(bytes, targetDir)).rejects.toThrow();
  });
});
