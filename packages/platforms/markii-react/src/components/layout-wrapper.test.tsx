import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { renderMark } from '../render';
import { defaultRegistry } from './index';
import {
  createLayoutWrapper,
  LAYOUT_WRAPPER_PRESETS,
  type LayoutWrapperPreset,
} from './layout-wrapper';

const EXPECTED_CLASSES: Record<LayoutWrapperPreset, string> = {
  center: 'mk-layout mk-align-center',
  left: 'mk-layout mk-align-left',
  right: 'mk-layout mk-align-right',
  wide: 'mk-layout mk-width-wide',
  narrow: 'mk-layout mk-width-narrow',
  full: 'mk-layout mk-width-full',
};

describe('createLayoutWrapper', () => {
  it.each(LAYOUT_WRAPPER_PRESETS)(
    '%s produces exactly its mapped classes on a single <div>',
    (preset) => {
      const Wrapper = createLayoutWrapper(preset);
      const { container } = render(<Wrapper attributes={{}}>x</Wrapper>);
      const el = container.firstElementChild;
      expect(el?.tagName).toBe('DIV');
      expect(el?.className).toBe(EXPECTED_CLASSES[preset]);
      // exactly one element: no extra wrapper, no stray siblings
      expect(container.children).toHaveLength(1);
    },
  );

  it('never reads attributes: an attribute-bearing invocation renders identically to an attribute-free one', () => {
    const Wrapper = createLayoutWrapper('center');
    const { container: withAttrs } = render(
      <Wrapper attributes={{ foo: 'bar', width: 'narrow' }}>x</Wrapper>,
    );
    const { container: withoutAttrs } = render(
      <Wrapper attributes={{}}>x</Wrapper>,
    );
    expect(withAttrs.firstElementChild?.className).toBe(
      withoutAttrs.firstElementChild?.className,
    );
  });

  it('does not throw and renders an empty <div> when children are absent', () => {
    const Wrapper = createLayoutWrapper('full');
    expect(() => render(<Wrapper attributes={{}} />)).not.toThrow();
    const { container } = render(<Wrapper attributes={{}} />);
    expect(container.firstElementChild?.tagName).toBe('DIV');
    expect(container.firstElementChild?.textContent).toBe('');
  });
});

describe('renderMark — layout-wrapper container directives', () => {
  it.each(LAYOUT_WRAPPER_PRESETS)(
    ':::%s renders a single div with its mapped classes',
    (preset) => {
      const { container } = render(
        renderMark(`:::${preset}\ncontent\n:::`, defaultRegistry),
      );
      const el = container.querySelector('.mk-layout');
      expect(el).not.toBeNull();
      expect(el?.className).toBe(EXPECTED_CLASSES[preset]);
    },
  );

  it('nests a width wrapper inside an alignment wrapper, composing both classes in the right order (::::center wrapping :::narrow)', () => {
    const { container } = render(
      renderMark(
        ['::::center', ':::narrow', 'nested content', ':::', '::::'].join('\n'),
        defaultRegistry,
      ),
    );
    const outer = container.querySelector(
      '.mk-layout.mk-align-center',
    ) as HTMLElement | null;
    expect(outer).not.toBeNull();
    const inner = outer?.querySelector('.mk-layout.mk-width-narrow');
    expect(inner).not.toBeNull();
    // the width wrapper is nested INSIDE the alignment wrapper, not a sibling
    expect(outer?.contains(inner as Node)).toBe(true);
    expect(inner?.textContent).toContain('nested content');
  });

  it(':::center around a GFM table renders the table untouched inside the wrapper', () => {
    const { container } = render(
      renderMark(
        [
          ':::center',
          '| Name  | Role     |',
          '| ----- | -------- |',
          '| Ada   | Engineer |',
          ':::',
        ].join('\n'),
        defaultRegistry,
      ),
    );
    const wrapper = container.querySelector('.mk-layout.mk-align-center');
    expect(wrapper).not.toBeNull();
    const table = wrapper?.querySelector('table');
    expect(table).not.toBeNull();
    expect(table?.textContent).toContain('Ada');
    expect(table?.textContent).toContain('Engineer');
  });

  it(':::right around an image renders the image untouched inside the wrapper', () => {
    const { container } = render(
      renderMark(
        ':::right\n![A cat](https://example.com/cat.png)\n:::',
        defaultRegistry,
      ),
    );
    const wrapper = container.querySelector('.mk-layout.mk-align-right');
    expect(wrapper).not.toBeNull();
    const img = wrapper?.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('https://example.com/cat.png');
    expect(img?.getAttribute('alt')).toBe('A cat');
  });

  it(':::wide around a paragraph renders the paragraph text untouched inside the wrapper', () => {
    const { container } = render(
      renderMark(':::wide\nplain paragraph text\n:::', defaultRegistry),
    );
    const wrapper = container.querySelector('.mk-layout.mk-width-wide');
    expect(wrapper).not.toBeNull();
    const paragraph = wrapper?.querySelector('p');
    expect(paragraph?.textContent).toBe('plain paragraph text');
  });

  it('an unknown directive nested inside a wrapper still renders the unknown-directive fallback box unchanged', () => {
    const { container } = render(
      renderMark(':::center\n::totally-unregistered\n:::', defaultRegistry),
    );
    const wrapper = container.querySelector('.mk-layout.mk-align-center');
    expect(wrapper).not.toBeNull();
    const fallback = wrapper?.querySelector('.mk-unknown.mk-unknown--block');
    expect(fallback).not.toBeNull();
    expect(fallback?.textContent).toContain('totally-unregistered');
  });

  it('attributes written on a wrapper directive (other than the reserved width/align keys) are ignored', () => {
    const { container } = render(
      renderMark(':::center{foo=bar}\ncontent\n:::', defaultRegistry),
    );
    const wrapper = container.querySelector('.mk-layout');
    expect(wrapper?.className).toBe('mk-layout mk-align-center');
    expect(wrapper?.getAttribute('foo')).toBeNull();
  });

  it(
    'documents the reserved-attribute behavior: :::center{width=narrow} produces an OUTER ' +
      "mk-width-narrow div (render.tsx's existing reserved-attribute interception), " +
      "wrapping the wrapper component's own mk-layout mk-align-center div — this is existing " +
      'render.tsx behavior, not something layout-wrapper.tsx changes',
    () => {
      const { container } = render(
        renderMark(':::center{width=narrow}\ncontent\n:::', defaultRegistry),
      );
      const outer = container.firstElementChild;
      expect(outer?.className).toBe('mk-width-narrow');
      const inner = outer?.firstElementChild;
      expect(inner?.className).toBe('mk-layout mk-align-center');
      expect(inner?.textContent).toContain('content');
    },
  );

  it(':::narrow with an empty body does not throw and renders an empty wrapper div', () => {
    expect(() =>
      render(renderMark(':::narrow\n:::', defaultRegistry)),
    ).not.toThrow();
    const { container } = render(renderMark(':::narrow\n:::', defaultRegistry));
    const wrapper = container.querySelector('.mk-layout.mk-width-narrow');
    expect(wrapper).not.toBeNull();
  });
});
