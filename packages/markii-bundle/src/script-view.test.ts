import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ScriptCapabilityError } from './errors';
import type { BundleManifest } from './manifest';
import { createScriptView, grantAllDeclaredPermissions } from './script-view';
import { openZipBundle } from './zip';

function u8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function fixtureStorage() {
  const bytes = zipSync({
    'note.mk.md': u8('# hello'),
    'manifest.json': u8('{"mark":"0.1.0"}'),
    'assets/x.png': u8('img'),
    'cache/data.json': u8('{}'),
  });
  return openZipBundle(bytes);
}

function manifestWith(
  permissions: BundleManifest['permissions'],
): BundleManifest {
  return { mark: '0.1.0', permissions };
}

/** Convenience: grant exactly what the manifest declares (the "fully trusted" pattern). */
function trustDeclared(manifest: BundleManifest) {
  return grantAllDeclaredPermissions(manifest);
}

describe('createScriptView — default grant (no 3rd argument)', () => {
  it('DEFECT 10: denies everything by default even when the manifest declares full permissions', () => {
    // No 3rd argument at all — the untrusted-by-default case. A hostile
    // .mkz bundle (or a legacy .mkbundle one) declaring every permission it
    // can think of must not be able to self-grant just by asking.
    const manifest = manifestWith({
      bundle: ['read', 'write:cache/'],
    });
    const view = createScriptView(fixtureStorage(), manifest);
    return Promise.all([
      expect(view.read('assets/x.png')).rejects.toThrow(ScriptCapabilityError),
      expect(view.exists('assets/x.png')).rejects.toThrow(
        ScriptCapabilityError,
      ),
      expect(view.write('cache/out.json', u8('{}'))).rejects.toThrow(
        ScriptCapabilityError,
      ),
    ]);
  });
});

describe('createScriptView — intersection semantics (DEFECT 10)', () => {
  it('a manifest that declares nothing gets nothing, even if the user grants everything', () => {
    // The user approving "read + write:cache/" for a note whose manifest
    // never asked for bundle access at all must not conjure capabilities
    // the note never declared wanting.
    const manifest = manifestWith(undefined);
    const view = createScriptView(fixtureStorage(), manifest, {
      bundle: ['read', 'write:cache/'],
    });
    return Promise.all([
      expect(view.read('assets/x.png')).rejects.toThrow(ScriptCapabilityError),
      expect(view.write('cache/out.json', u8('{}'))).rejects.toThrow(
        ScriptCapabilityError,
      ),
    ]);
  });

  it('a manifest that declares everything gets nothing if the user grants nothing', () => {
    const manifest = manifestWith({ bundle: ['read', 'write:cache/'] });
    const view = createScriptView(fixtureStorage(), manifest, {});
    return Promise.all([
      expect(view.read('assets/x.png')).rejects.toThrow(ScriptCapabilityError),
      expect(view.write('cache/out.json', u8('{}'))).rejects.toThrow(
        ScriptCapabilityError,
      ),
    ]);
  });

  it('the manifest narrows: user grants both, manifest declares read-only -> write still denied', async () => {
    const manifest = manifestWith({ bundle: ['read'] });
    const view = createScriptView(fixtureStorage(), manifest, {
      bundle: ['read', 'write:cache/'],
    });
    expect(await view.read('assets/x.png')).toEqual(u8('img'));
    await expect(view.write('cache/out.json', u8('{}'))).rejects.toThrow(
      ScriptCapabilityError,
    );
  });

  it('the user grant narrows: manifest declares both, user grants read-only -> write still denied', async () => {
    const manifest = manifestWith({ bundle: ['read', 'write:cache/'] });
    const view = createScriptView(fixtureStorage(), manifest, {
      bundle: ['read'],
    });
    expect(await view.read('assets/x.png')).toEqual(u8('img'));
    await expect(view.write('cache/out.json', u8('{}'))).rejects.toThrow(
      ScriptCapabilityError,
    );
  });

  it('both sides agreeing on write:cache/ allows a cache write', async () => {
    const manifest = manifestWith({ bundle: ['write:cache/'] });
    const storage = fixtureStorage();
    const view = createScriptView(storage, manifest, {
      bundle: ['write:cache/'],
    });
    await view.write('cache/out.json', u8('{"ok":true}'));
    expect(await storage.read('cache/out.json')).toEqual(u8('{"ok":true}'));
  });
});

describe('grantAllDeclaredPermissions — the explicit fully-trusted opt-in', () => {
  it('reproduces the old "trust the manifest" behavior when explicitly opted into', async () => {
    const manifest = manifestWith({ bundle: ['read', 'write:cache/'] });
    const view = createScriptView(
      fixtureStorage(),
      manifest,
      trustDeclared(manifest),
    );
    expect(await view.read('note.mk.md')).toEqual(u8('# hello'));
    await view.write('cache/out.json', u8('{}'));
  });

  it('returns {} for a manifest with no permissions (still zero grants)', () => {
    const manifest = manifestWith(undefined);
    expect(grantAllDeclaredPermissions(manifest)).toEqual({});
  });
});

describe('createScriptView — no grants', () => {
  it('denies reads with no permissions declared at all', async () => {
    const manifest = manifestWith(undefined);
    const view = createScriptView(
      fixtureStorage(),
      manifest,
      trustDeclared(manifest),
    );
    await expect(view.read('assets/x.png')).rejects.toThrow(
      ScriptCapabilityError,
    );
  });

  it('denies exists with no permissions declared', async () => {
    const manifest = manifestWith(undefined);
    const view = createScriptView(
      fixtureStorage(),
      manifest,
      trustDeclared(manifest),
    );
    await expect(view.exists('assets/x.png')).rejects.toThrow(
      ScriptCapabilityError,
    );
  });

  it('denies writes with no permissions declared', async () => {
    const manifest = manifestWith(undefined);
    const view = createScriptView(
      fixtureStorage(),
      manifest,
      trustDeclared(manifest),
    );
    await expect(view.write('cache/out.json', u8('{}'))).rejects.toThrow(
      ScriptCapabilityError,
    );
  });

  it('denies reads when bundle grants array is empty', async () => {
    const manifest = manifestWith({ bundle: [] });
    const view = createScriptView(
      fixtureStorage(),
      manifest,
      trustDeclared(manifest),
    );
    await expect(view.read('assets/x.png')).rejects.toThrow(
      ScriptCapabilityError,
    );
  });
});

describe('createScriptView — read grant', () => {
  it('allows reads bundle-wide', async () => {
    const manifest = manifestWith({ bundle: ['read'] });
    const view = createScriptView(
      fixtureStorage(),
      manifest,
      trustDeclared(manifest),
    );
    expect(await view.read('assets/x.png')).toEqual(u8('img'));
    expect(await view.read('note.mk.md')).toEqual(u8('# hello'));
    expect(await view.read('manifest.json')).toEqual(u8('{"mark":"0.1.0"}'));
  });

  it('allows exists bundle-wide', async () => {
    const manifest = manifestWith({ bundle: ['read'] });
    const view = createScriptView(
      fixtureStorage(),
      manifest,
      trustDeclared(manifest),
    );
    expect(await view.exists('note.mk.md')).toBe(true);
    expect(await view.exists('nope.txt')).toBe(false);
  });

  it('still denies writes with only the read grant', async () => {
    const manifest = manifestWith({ bundle: ['read'] });
    const view = createScriptView(
      fixtureStorage(),
      manifest,
      trustDeclared(manifest),
    );
    await expect(view.write('cache/out.json', u8('{}'))).rejects.toThrow(
      ScriptCapabilityError,
    );
  });
});

describe('createScriptView — write:cache/ grant', () => {
  it('allows a cache/ write', async () => {
    const storage = fixtureStorage();
    const manifest = manifestWith({ bundle: ['write:cache/'] });
    const view = createScriptView(storage, manifest, trustDeclared(manifest));
    await view.write('cache/out.json', u8('{"ok":true}'));
    expect(await storage.read('cache/out.json')).toEqual(u8('{"ok":true}'));
  });

  it('denies writing manifest.json even with write:cache/ granted', async () => {
    const manifest = manifestWith({ bundle: ['write:cache/'] });
    const view = createScriptView(
      fixtureStorage(),
      manifest,
      trustDeclared(manifest),
    );
    await expect(
      view.write('manifest.json', u8('{"mark":"9.9.9"}')),
    ).rejects.toThrow(ScriptCapabilityError);
  });

  it('denies writing note.mk.md even with write:cache/ granted', async () => {
    const manifest = manifestWith({ bundle: ['write:cache/'] });
    const view = createScriptView(
      fixtureStorage(),
      manifest,
      trustDeclared(manifest),
    );
    await expect(view.write('note.mk.md', u8('# hacked'))).rejects.toThrow(
      ScriptCapabilityError,
    );
  });

  it('denies writing assets/x (outside cache/) even with write:cache/ granted', async () => {
    const manifest = manifestWith({ bundle: ['write:cache/'] });
    const view = createScriptView(
      fixtureStorage(),
      manifest,
      trustDeclared(manifest),
    );
    await expect(view.write('assets/x.png', u8('overwritten'))).rejects.toThrow(
      ScriptCapabilityError,
    );
  });

  it('a manifest maliciously listing write:cache/ still cannot write manifest.json, even fully trusted', async () => {
    // Simulates a hostile/tampered manifest object claiming a grant that
    // would let it rewrite its own permissions — isWriteAllowed's
    // unconditional manifest.json denial must hold regardless, even in the
    // fully-trusted (grant === declared) case.
    const storage = fixtureStorage();
    const hostileManifest: BundleManifest = {
      mark: '0.1.0',
      permissions: { bundle: ['read', 'write:cache/'] },
    };
    const view = createScriptView(
      storage,
      hostileManifest,
      trustDeclared(hostileManifest),
    );
    await expect(
      view.write(
        'manifest.json',
        u8(
          '{"mark":"0.1.0","permissions":{"bundle":["read","write:cache/"],"net":{"get":["evil.example"]}}}',
        ),
      ),
    ).rejects.toThrow(ScriptCapabilityError);
    // The stored manifest.json must be untouched.
    expect(await storage.read('manifest.json')).toEqual(u8('{"mark":"0.1.0"}'));
  });
});
