import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { renderMark } from './render';
import {
  createRegistry,
  type MarkComponentProps,
  type Registry,
  type RegistryEntry,
} from './registry';

/** An ordinary, well-behaved component — used as a control to prove the
 * rest of the document is unaffected by a hostile entry elsewhere. */
function Chip({ children }: MarkComponentProps) {
  return <span className="probe-chip">{children}</span>;
}

/**
 * Builds a registry entry whose `component` property is a GETTER that
 * throws — the hostile-registry-configuration case from the TODO backlog
 * (same family as `isFormMismatch`'s `entry.inline` guard, but for the
 * property every directive actually reads to obtain its component).
 */
function throwingComponentEntry(): RegistryEntry {
  const entry = {} as RegistryEntry;
  Object.defineProperty(entry, 'component', {
    get() {
      throw new Error('hostile component getter');
    },
    enumerable: true,
  });
  return entry;
}

function html(source: string, registry: Registry): HTMLElement {
  return render(renderMark(source, registry)).container;
}

describe('registry entry with a throwing `component` getter', () => {
  it('degrades to the unknown-directive fallback in block (leaf) form', () => {
    const registry = createRegistry({ trap: throwingComponentEntry() });
    expect(() => html('::trap{}', registry)).not.toThrow();
    const container = html('::trap{}', registry);
    const fallback = container.querySelector('.mk-unknown');
    expect(fallback?.tagName).toBe('DIV');
    expect(fallback?.textContent).toContain('unknown component');
    expect(fallback?.textContent).toContain('trap');
  });

  it('degrades to the unknown-directive fallback in container (block) form', () => {
    const registry = createRegistry({ trap: throwingComponentEntry() });
    const source = ':::trap\nbody\n:::';
    expect(() => html(source, registry)).not.toThrow();
    const container = html(source, registry);
    const fallback = container.querySelector('.mk-unknown');
    expect(fallback?.tagName).toBe('DIV');
    expect(fallback?.textContent).toContain('body');
  });

  it('degrades to the unknown-directive fallback in inline (text) form', () => {
    const registry = createRegistry({ trap: throwingComponentEntry() });
    const source = 'before :trap[body] after';
    expect(() => html(source, registry)).not.toThrow();
    const container = html(source, registry);
    const fallback = container.querySelector('.mk-unknown');
    expect(fallback?.tagName).toBe('SPAN');
    expect(fallback?.textContent).toContain('body');
    expect(container.textContent).toContain('before');
    expect(container.textContent).toContain('after');
  });

  it('degrades when the throwing entry is reached via an ALIAS TARGET', () => {
    const registry = createRegistry(
      { trap: throwingComponentEntry() },
      { hero: { name: 'trap' } },
    );
    const source = 'before :hero[body] after';
    expect(() => html(source, registry)).not.toThrow();
    const container = html(source, registry);
    const fallback = container.querySelector('.mk-unknown');
    expect(fallback).not.toBeNull();
    // Reported under the TARGET name, like every other alias fallback
    // (`resolveDirectiveAlias`'s rule 3).
    expect(fallback?.textContent).toContain('trap');
    expect(container.textContent).toContain('body');
  });

  it('degrades when the throwing entry is itself the ALIAS SOURCE lookup', () => {
    // `resolveDirectiveAlias` checks `hasComponent(registry, name)` for the
    // written name FIRST, before ever consulting the alias table — so a
    // throwing getter on the written name itself must not escape there
    // either, regardless of whether an alias for that name also exists.
    const registry = createRegistry(
      { trap: throwingComponentEntry() },
      { trap: { name: 'chip' } },
    );
    const source = ':trap[body]';
    expect(() => html(source, registry)).not.toThrow();
  });

  it('leaves the rest of the document rendering normally', () => {
    const registry = createRegistry({
      trap: throwingComponentEntry(),
      chip: { component: Chip, inline: true },
    });
    const source = 'para one\n\n::trap{}\n\npara :chip[two] three';
    const container = html(source, registry);
    expect(container.textContent).toContain('para one');
    expect(container.textContent).toContain('para');
    expect(container.querySelector('.probe-chip')?.textContent).toBe('two');
    expect(container.querySelectorAll('.mk-unknown')).toHaveLength(1);
  });
});
