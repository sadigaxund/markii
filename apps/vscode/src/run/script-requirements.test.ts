import { describe, expect, it } from 'vitest';
import { computeGrantKey, type GrantClosure } from '@markii/runtime';
import { extractRunRequirements } from './script-requirements';

function fence(name: string, body: string): string {
  return '```lua {name=' + name + '}\n' + body + '\n```\n';
}

describe('extractRunRequirements — script blocks', () => {
  it('returns every inline script block, in document order', () => {
    const text = fence('a', 'return 1') + '\n' + fence('b', 'return 2');
    const requirements = extractRunRequirements(text);
    expect(requirements.scripts.map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('a document with no script blocks returns an empty everything', () => {
    const requirements = extractRunRequirements(
      '# just a heading\n\nsome text',
    );
    expect(requirements.scripts).toEqual([]);
    expect(requirements.hosts).toEqual([]);
    expect(requirements.hasUnknownHosts).toBe(false);
    expect(requirements.grantScripts).toEqual([]);
  });
});

describe('extractRunRequirements — literal host extraction', () => {
  it('picks up a sole string-literal URL passed to net.fetch_json', () => {
    const text = fence(
      'a',
      'return net.fetch_json("https://api.example.com/x")',
    );
    const requirements = extractRunRequirements(text);
    expect(requirements.hosts).toEqual(['api.example.com']);
    expect(requirements.hasUnknownHosts).toBe(false);
  });

  it('picks up net.post and net.patch literal URLs too, ignoring the second (body) argument', () => {
    const text =
      fence('a', 'return net.post("https://post.example.com/x", "{}")') +
      '\n' +
      fence('b', 'return net.patch("https://patch.example.com/y", "{}")');
    const requirements = extractRunRequirements(text);
    expect(requirements.hosts.sort()).toEqual([
      'patch.example.com',
      'post.example.com',
    ]);
    expect(requirements.hasUnknownHosts).toBe(false);
  });

  it('dedupes repeated hosts and preserves first-seen order', () => {
    const text = fence(
      'a',
      'net.fetch_json("https://b.example.com/1")\nreturn net.fetch_json("https://a.example.com/1")',
    );
    const requirements = extractRunRequirements(text);
    expect(requirements.hosts).toEqual(['b.example.com', 'a.example.com']);
  });

  it('a single-quoted literal is recognized the same as a double-quoted one', () => {
    const text = fence(
      'a',
      "return net.fetch_json('https://api.example.com/x')",
    );
    const requirements = extractRunRequirements(text);
    expect(requirements.hosts).toEqual(['api.example.com']);
    expect(requirements.hasUnknownHosts).toBe(false);
  });

  it('a concatenated literal is a MISS on the host list and sets hasUnknownHosts', () => {
    const text = fence(
      'a',
      'local host = "api.example.com"\nreturn net.fetch_json("https://" .. host .. "/x")',
    );
    const requirements = extractRunRequirements(text);
    expect(requirements.hosts).toEqual([]);
    expect(requirements.hasUnknownHosts).toBe(true);
  });

  it('a bare variable argument sets hasUnknownHosts without adding a host', () => {
    const text = fence(
      'a',
      'local url = "https://api.example.com/x"\nreturn net.fetch_json(url)',
    );
    const requirements = extractRunRequirements(text);
    expect(requirements.hosts).toEqual([]);
    expect(requirements.hasUnknownHosts).toBe(true);
  });

  it('a src= long-script reference sets hasUnknownHosts (its source is not in this document)', () => {
    const text = '```lua {name=a src=scripts/etl.lua}\n```\n';
    const requirements = extractRunRequirements(text);
    expect(requirements.scripts).toHaveLength(1);
    expect(requirements.scripts[0]?.src).toBe('scripts/etl.lua');
    expect(requirements.hasUnknownHosts).toBe(true);
    expect(requirements.hosts).toEqual([]);
  });

  it('a literal that is not a parseable absolute URL is unknown, not silently dropped', () => {
    const text = fence('a', 'return net.fetch_json("not-a-url")');
    const requirements = extractRunRequirements(text);
    expect(requirements.hosts).toEqual([]);
    expect(requirements.hasUnknownHosts).toBe(true);
  });
});

describe('extractRunRequirements — grantScripts / computeGrantKey stability', () => {
  it('grantScripts mirrors each ScriptBlock as a GrantClosureScript record', () => {
    const text = fence('a', 'return 1');
    const requirements = extractRunRequirements(text);
    expect(requirements.grantScripts).toEqual([
      { name: 'a', lang: 'lua', code: 'return 1' },
    ]);
  });

  it('a src= block carries its src field through to the grant record', () => {
    const text = '```lua {name=a src=scripts/etl.lua}\n```\n';
    const requirements = extractRunRequirements(text);
    expect(requirements.grantScripts).toEqual([
      { name: 'a', lang: 'lua', src: 'scripts/etl.lua', code: '' },
    ]);
  });

  it('extracting the same text twice produces byte-identical grantScripts and an identical grant key', async () => {
    const text =
      fence('a', 'return net.fetch_json("https://api.example.com/x")') +
      '\n' +
      fence('b', 'return 2');

    const first = extractRunRequirements(text);
    const second = extractRunRequirements(text);
    expect(first.grantScripts).toEqual(second.grantScripts);

    const closureFrom = (scripts: typeof first.grantScripts): GrantClosure => ({
      scripts,
      bundleModules: {},
      vaultModules: {},
      packs: [],
    });

    const keyOne = await computeGrantKey(closureFrom(first.grantScripts));
    const keyTwo = await computeGrantKey(closureFrom(second.grantScripts));
    expect(keyOne).toBe(keyTwo);
  });

  it('changing a script body changes the grant key (the closure the grant is keyed to)', async () => {
    const before = extractRunRequirements(fence('a', 'return 1'));
    const after = extractRunRequirements(fence('a', 'return 2'));

    const closureFrom = (
      scripts: typeof before.grantScripts,
    ): GrantClosure => ({
      scripts,
      bundleModules: {},
      vaultModules: {},
      packs: [],
    });

    const keyBefore = await computeGrantKey(closureFrom(before.grantScripts));
    const keyAfter = await computeGrantKey(closureFrom(after.grantScripts));
    expect(keyBefore).not.toBe(keyAfter);
  });
});
