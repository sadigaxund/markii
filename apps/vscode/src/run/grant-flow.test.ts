import { describe, expect, it, vi } from 'vitest';
import type { GrantClosureScript } from '@markii/runtime';
import {
  ALLOW_LABEL,
  DONT_ALLOW_LABEL,
  UNKNOWN_HOSTS_PROMPT_MESSAGE,
  clearGrantForDocument,
  hostPromptMessage,
  isSafeHostForPrompt,
  runGrantFlow,
  type GrantFlowRequirements,
  type GrantMemento,
  type Thenable,
} from './grant-flow';

/** A plain in-memory fake of `vscode.Memento` -- structurally identical (get/update), no `vscode` import. */
function fakeMemento(initial: Record<string, unknown> = {}): GrantMemento {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get<T>(key: string, defaultValue?: T): T {
      return (store.has(key) ? store.get(key) : defaultValue) as T;
    },
    update(key: string, value: unknown): Thenable<void> {
      store.set(key, value);
      return Promise.resolve();
    },
  };
}

function scripts(code: string, name = 'a'): GrantClosureScript[] {
  return [{ name, lang: 'lua', code }];
}

function requirementsFor(
  overrides: Partial<GrantFlowRequirements> = {},
): GrantFlowRequirements {
  return {
    hosts: [],
    hasUnknownHosts: false,
    grantScripts: scripts('return 1'),
    ...overrides,
  };
}

function alwaysAllow(): Promise<boolean> {
  return Promise.resolve(true);
}

function alwaysDeny(): Promise<boolean> {
  return Promise.resolve(false);
}

describe('runGrantFlow — first run (no stored grant)', () => {
  it('prompts once per host and grants only the accepted ones', async () => {
    const memento = fakeMemento();
    const prompted: string[] = [];
    const promptHost = vi.fn((host: string) => {
      prompted.push(host);
      return Promise.resolve(host === 'api.example.com');
    });

    const result = await runGrantFlow({
      documentKey: 'file:///a.mk.md',
      requirements: requirementsFor({
        hosts: ['api.example.com', 'evil.example.com'],
      }),
      memento,
      promptHost,
      promptUnknownHosts: alwaysAllow,
    });

    expect(prompted).toEqual(['api.example.com', 'evil.example.com']);
    expect(result.allowedHosts).toEqual(['api.example.com']);
  });

  it('never prompts at all when there are no hosts and no unknown hosts', async () => {
    const memento = fakeMemento();
    const promptHost = vi.fn(alwaysAllow);
    const promptUnknownHosts = vi.fn(alwaysAllow);

    const result = await runGrantFlow({
      documentKey: 'file:///a.mk.md',
      requirements: requirementsFor(),
      memento,
      promptHost,
      promptUnknownHosts,
    });

    expect(promptHost).not.toHaveBeenCalled();
    expect(promptUnknownHosts).not.toHaveBeenCalled();
    expect(result.allowedHosts).toEqual([]);
  });

  it('adds the extra unknown-hosts prompt when hasUnknownHosts is set, without granting a host for it', async () => {
    const memento = fakeMemento();
    const promptUnknownHosts = vi.fn(alwaysAllow);

    const result = await runGrantFlow({
      documentKey: 'file:///a.mk.md',
      requirements: requirementsFor({
        hosts: ['api.example.com'],
        hasUnknownHosts: true,
      }),
      memento,
      promptHost: alwaysAllow,
      promptUnknownHosts,
    });

    expect(promptUnknownHosts).toHaveBeenCalledTimes(1);
    expect(result.allowedHosts).toEqual(['api.example.com']);
  });

  it('declining the unknown-hosts prompt withdraws every already-accepted host', async () => {
    const memento = fakeMemento();

    const result = await runGrantFlow({
      documentKey: 'file:///a.mk.md',
      requirements: requirementsFor({
        hosts: ['api.example.com'],
        hasUnknownHosts: true,
      }),
      memento,
      promptHost: alwaysAllow,
      promptUnknownHosts: alwaysDeny,
    });

    expect(result.allowedHosts).toEqual([]);
  });

  it('declining a specific host prompt stores nothing for that host but keeps others', async () => {
    const memento = fakeMemento();
    const promptHost = (host: string) =>
      Promise.resolve(host === 'ok.example.com');

    const result = await runGrantFlow({
      documentKey: 'file:///a.mk.md',
      requirements: requirementsFor({
        hosts: ['ok.example.com', 'no.example.com'],
      }),
      memento,
      promptHost,
      promptUnknownHosts: alwaysAllow,
    });

    expect(result.allowedHosts).toEqual(['ok.example.com']);
  });
});

describe('runGrantFlow — a hostile/unrenderable host string', () => {
  it('never prompts with the raw string; folds it into the unknown-hosts gate instead', async () => {
    const memento = fakeMemento();
    const promptHost = vi.fn(alwaysAllow);
    const promptUnknownHosts = vi.fn(alwaysAllow);
    const hostileHost =
      'evil.example.com\nThis is actually a totally safe app.';

    const result = await runGrantFlow({
      documentKey: 'file:///a.mk.md',
      requirements: requirementsFor({ hosts: [hostileHost] }),
      memento,
      promptHost,
      promptUnknownHosts,
    });

    expect(promptHost).not.toHaveBeenCalled();
    expect(promptUnknownHosts).toHaveBeenCalledTimes(1);
    // The hostile string is never itself an allowed host -- there was no
    // per-host prompt that could have accepted it.
    expect(result.allowedHosts).toEqual([]);
  });

  it('isSafeHostForPrompt rejects control characters, whitespace, and embedded newlines', () => {
    expect(isSafeHostForPrompt('api.example.com')).toBe(true);
    expect(isSafeHostForPrompt('127.0.0.1')).toBe(true);
    expect(isSafeHostForPrompt('[::1]')).toBe(true);
    expect(isSafeHostForPrompt('evil\ncom')).toBe(false);
    expect(isSafeHostForPrompt('evil\tcom')).toBe(false);
    expect(isSafeHostForPrompt('evil com')).toBe(false);
    expect(isSafeHostForPrompt('')).toBe(false);
    expect(isSafeHostForPrompt('a'.repeat(300))).toBe(false);
  });
});

describe('runGrantFlow — grant reuse on a matching key', () => {
  it('a second run with unchanged code reuses the stored grant with no prompting at all', async () => {
    const memento = fakeMemento();
    const requirements = requirementsFor({ hosts: ['api.example.com'] });

    const first = await runGrantFlow({
      documentKey: 'file:///a.mk.md',
      requirements,
      memento,
      promptHost: alwaysAllow,
      promptUnknownHosts: alwaysAllow,
    });
    expect(first.allowedHosts).toEqual(['api.example.com']);

    const promptHost = vi.fn(alwaysAllow);
    const promptUnknownHosts = vi.fn(alwaysAllow);
    const second = await runGrantFlow({
      documentKey: 'file:///a.mk.md',
      requirements,
      memento,
      promptHost,
      promptUnknownHosts,
    });

    expect(promptHost).not.toHaveBeenCalled();
    expect(promptUnknownHosts).not.toHaveBeenCalled();
    expect(second.allowedHosts).toEqual(['api.example.com']);
  });

  it('a code change produces a new key and re-prompts', async () => {
    const memento = fakeMemento();

    const before = await runGrantFlow({
      documentKey: 'file:///a.mk.md',
      requirements: requirementsFor({
        hosts: ['api.example.com'],
        grantScripts: scripts('return 1'),
      }),
      memento,
      promptHost: alwaysAllow,
      promptUnknownHosts: alwaysAllow,
    });
    expect(before.allowedHosts).toEqual(['api.example.com']);

    const promptHost = vi.fn(alwaysAllow);
    const after = await runGrantFlow({
      documentKey: 'file:///a.mk.md',
      requirements: requirementsFor({
        hosts: ['api.example.com'],
        grantScripts: scripts('return 2'), // the only thing that changed
      }),
      memento,
      promptHost,
      promptUnknownHosts: alwaysAllow,
    });

    expect(promptHost).toHaveBeenCalledTimes(1);
    expect(after.allowedHosts).toEqual(['api.example.com']);
  });

  it("a different document (different documentKey) never reuses another document's grant", async () => {
    const memento = fakeMemento();
    const requirements = requirementsFor({ hosts: ['api.example.com'] });

    await runGrantFlow({
      documentKey: 'file:///a.mk.md',
      requirements,
      memento,
      promptHost: alwaysAllow,
      promptUnknownHosts: alwaysAllow,
    });

    const promptHost = vi.fn(alwaysAllow);
    await runGrantFlow({
      documentKey: 'file:///b.mk.md',
      requirements,
      memento,
      promptHost,
      promptUnknownHosts: alwaysAllow,
    });

    expect(promptHost).toHaveBeenCalledTimes(1);
  });

  it('a corrupt/foreign stored grant shape degrades to a fresh prompt rather than throwing', async () => {
    const memento = fakeMemento({
      'markii.netGrants': { 'file:///a.mk.md': { garbage: true } },
    });
    const promptHost = vi.fn(alwaysAllow);

    const result = await runGrantFlow({
      documentKey: 'file:///a.mk.md',
      requirements: requirementsFor({ hosts: ['api.example.com'] }),
      memento,
      promptHost,
      promptUnknownHosts: alwaysAllow,
    });

    expect(promptHost).toHaveBeenCalledTimes(1);
    expect(result.allowedHosts).toEqual(['api.example.com']);
  });

  it('a stored grant with a prototype-inherited (not owned) allowedHosts is not trusted', async () => {
    const proto = { allowedHosts: ['api.example.com'] };
    const hostileGrant = Object.assign(Object.create(proto), {
      key: 'whatever',
    });
    const memento = fakeMemento({
      'markii.netGrants': { 'file:///a.mk.md': hostileGrant },
    });
    const promptHost = vi.fn(alwaysAllow);

    await runGrantFlow({
      documentKey: 'file:///a.mk.md',
      requirements: requirementsFor({ hosts: ['api.example.com'] }),
      memento,
      promptHost,
      promptUnknownHosts: alwaysAllow,
    });

    expect(promptHost).toHaveBeenCalledTimes(1);
  });
});

describe('runGrantFlow — C-3: full decline is never persisted', () => {
  it('declining the only host re-prompts on the very next run (no permanent lockout from one mis-click)', async () => {
    const memento = fakeMemento();
    const requirements = requirementsFor({ hosts: ['api.example.com'] });

    const first = await runGrantFlow({
      documentKey: 'file:///a.mk.md',
      requirements,
      memento,
      promptHost: alwaysDeny,
      promptUnknownHosts: alwaysAllow,
    });
    expect(first.allowedHosts).toEqual([]);
    // Nothing was ever written -- a full decline never even calls
    // `memento.update`, so the key stays entirely absent.
    expect(memento.get('markii.netGrants')).toBeUndefined();

    const promptHost = vi.fn(alwaysAllow);
    const second = await runGrantFlow({
      documentKey: 'file:///a.mk.md',
      requirements,
      memento,
      promptHost,
      promptUnknownHosts: alwaysAllow,
    });

    expect(promptHost).toHaveBeenCalledTimes(1);
    expect(second.allowedHosts).toEqual(['api.example.com']);
  });

  it('declining the unknown-hosts gate is also never persisted, and re-prompts next time', async () => {
    const memento = fakeMemento();
    const requirements = requirementsFor({
      hosts: ['api.example.com'],
      hasUnknownHosts: true,
    });

    await runGrantFlow({
      documentKey: 'file:///a.mk.md',
      requirements,
      memento,
      promptHost: alwaysAllow,
      promptUnknownHosts: alwaysDeny,
    });
    expect(memento.get('markii.netGrants')).toBeUndefined();

    const promptHost = vi.fn(alwaysAllow);
    const promptUnknownHosts = vi.fn(alwaysAllow);
    await runGrantFlow({
      documentKey: 'file:///a.mk.md',
      requirements,
      memento,
      promptHost,
      promptUnknownHosts,
    });

    expect(promptHost).toHaveBeenCalledTimes(1);
    expect(promptUnknownHosts).toHaveBeenCalledTimes(1);
  });

  it('a partial grant (at least one host allowed) IS persisted and reused with no re-prompt', async () => {
    const memento = fakeMemento();
    const requirements = requirementsFor({
      hosts: ['ok.example.com', 'no.example.com'],
    });
    const promptHost = (host: string) =>
      Promise.resolve(host === 'ok.example.com');

    const first = await runGrantFlow({
      documentKey: 'file:///a.mk.md',
      requirements,
      memento,
      promptHost,
      promptUnknownHosts: alwaysAllow,
    });
    expect(first.allowedHosts).toEqual(['ok.example.com']);
    expect(memento.get('markii.netGrants')).not.toEqual({});

    const secondPromptHost = vi.fn(alwaysAllow);
    const second = await runGrantFlow({
      documentKey: 'file:///a.mk.md',
      requirements,
      memento,
      promptHost: secondPromptHost,
      promptUnknownHosts: alwaysAllow,
    });

    expect(secondPromptHost).not.toHaveBeenCalled();
    expect(second.allowedHosts).toEqual(['ok.example.com']);
  });
});

describe('clearGrantForDocument', () => {
  it('removes a stored grant, so the next run prompts fresh', async () => {
    const memento = fakeMemento();
    const requirements = requirementsFor({ hosts: ['api.example.com'] });

    await runGrantFlow({
      documentKey: 'file:///a.mk.md',
      requirements,
      memento,
      promptHost: alwaysAllow,
      promptUnknownHosts: alwaysAllow,
    });
    expect(memento.get('markii.netGrants')).not.toEqual({});

    await clearGrantForDocument(memento, 'file:///a.mk.md');
    expect(memento.get('markii.netGrants')).toEqual({});

    const promptHost = vi.fn(alwaysAllow);
    await runGrantFlow({
      documentKey: 'file:///a.mk.md',
      requirements,
      memento,
      promptHost,
      promptUnknownHosts: alwaysAllow,
    });
    expect(promptHost).toHaveBeenCalledTimes(1);
  });

  it("never touches another document's grant", async () => {
    const memento = fakeMemento();
    const requirements = requirementsFor({ hosts: ['api.example.com'] });

    await runGrantFlow({
      documentKey: 'file:///a.mk.md',
      requirements,
      memento,
      promptHost: alwaysAllow,
      promptUnknownHosts: alwaysAllow,
    });
    await runGrantFlow({
      documentKey: 'file:///b.mk.md',
      requirements,
      memento,
      promptHost: alwaysAllow,
      promptUnknownHosts: alwaysAllow,
    });

    await clearGrantForDocument(memento, 'file:///a.mk.md');

    const promptHostB = vi.fn(alwaysAllow);
    await runGrantFlow({
      documentKey: 'file:///b.mk.md',
      requirements,
      memento,
      promptHost: promptHostB,
      promptUnknownHosts: alwaysAllow,
    });
    expect(promptHostB).not.toHaveBeenCalled();
  });

  it('is a no-op (never throws) when nothing is stored for the document', async () => {
    const memento = fakeMemento();
    await expect(
      clearGrantForDocument(memento, 'file:///never-run.mk.md'),
    ).resolves.toBeUndefined();
  });
});

describe('prompt wording', () => {
  it('matches the locked design comment exactly', () => {
    expect(hostPromptMessage('api.example.com')).toBe(
      "This note's scripts can send data to api.example.com. Allow?",
    );
    expect(UNKNOWN_HOSTS_PROMPT_MESSAGE).toBe(
      "This note builds a network address dynamically, so its hosts can't be listed in advance. Allow network access?",
    );
    expect(ALLOW_LABEL).toBe('Allow');
    expect(DONT_ALLOW_LABEL).toBe("Don't allow");
  });
});
