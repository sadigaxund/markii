import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { renderMark } from '../render';
import { defaultRegistry } from './index';
import { Row } from './row';

describe('Row', () => {
  it.each(['2', '3', '4'])(
    'renders mk-row plus mk-row--cols-%s for an exact match',
    (cols) => {
      const { container } = render(<Row attributes={{ cols }}>x</Row>);
      const row = container.firstElementChild;
      expect(row).toHaveClass('mk-row');
      expect(row).toHaveClass(`mk-row--cols-${cols}`);
    },
  );

  it.each([
    ['99', 'out of range'],
    ['-1', 'negative'],
    ['abc', 'non-numeric'],
    ['2.0', 'not an exact integer string'],
    [' 2', 'leading whitespace'],
  ])(
    'degrades to plain mk-row (auto-fit) for an invalid cols value (%s: %s)',
    (cols) => {
      const { container } = render(<Row attributes={{ cols }}>x</Row>);
      const row = container.firstElementChild;
      expect(row).toHaveClass('mk-row');
      expect(row?.className).toBe('mk-row');
    },
  );

  it('degrades to plain mk-row (auto-fit) when cols is absent', () => {
    const { container } = render(<Row attributes={{}}>x</Row>);
    const row = container.firstElementChild;
    expect(row?.className).toBe('mk-row');
  });

  it('degrades to plain mk-row when cols is a bare (null) attribute', () => {
    const { container } = render(<Row attributes={{ cols: null }}>x</Row>);
    const row = container.firstElementChild;
    expect(row?.className).toBe('mk-row');
  });

  it('renders its children as-is (no per-cell wrapping)', () => {
    const { getByText } = render(
      <Row attributes={{}}>
        <div>cell content</div>
      </Row>,
    );
    expect(getByText('cell content')).toBeInTheDocument();
  });
});

describe('renderMark — :::row{cols=...} container directive', () => {
  it('renders a row with three stat cells given cols=3', () => {
    const { container } = render(
      renderMark(
        [
          ':::row{cols=3}',
          '::stat{value=1 label="a"}',
          '',
          '::stat{value=2 label="b"}',
          '',
          '::stat{value=3 label="c"}',
          ':::',
        ].join('\n'),
        defaultRegistry,
      ),
    );
    const row = container.querySelector('.mk-row.mk-row--cols-3');
    expect(row).not.toBeNull();
    expect(row?.querySelectorAll('.mk-stat')).toHaveLength(3);
  });

  it('degrades to auto-fit for an invalid cols value on a real directive', () => {
    const { container } = render(
      renderMark(':::row{cols=7}\n::stat{value=1}\n:::', defaultRegistry),
    );
    const row = container.querySelector('.mk-row');
    expect(row).not.toBeNull();
    expect(row?.className).toBe('mk-row');
  });

  it('degrades to auto-fit when cols is absent on a real directive', () => {
    const { container } = render(
      renderMark(':::row\n::stat{value=1}\n:::', defaultRegistry),
    );
    const row = container.querySelector('.mk-row');
    expect(row).not.toBeNull();
    expect(row?.className).toBe('mk-row');
  });
});

describe('renderMark — :::row{align=...} cascades into cells', () => {
  it.each(['left', 'center', 'right'])(
    'wraps the row in the generic mk-align-%s div (same reserved-attribute interception as any other block directive)',
    (align) => {
      const { container } = render(
        renderMark(
          `:::row{cols=2 align=${align}}\ncell one\n\ncell two\n:::`,
          defaultRegistry,
        ),
      );
      const outer = container.firstElementChild;
      expect(outer?.className).toBe(`mk-align-${align}`);
      const row = outer?.querySelector('.mk-row.mk-row--cols-2');
      expect(row).not.toBeNull();
      expect(outer?.firstElementChild).toBe(row);
    },
  );

  it('an invalid align value on a row degrades silently: no wrapper, plain mk-row', () => {
    const { container } = render(
      renderMark(
        ':::row{cols=2 align=diagonal}\ncell one\n\ncell two\n:::',
        defaultRegistry,
      ),
    );
    const outer = container.firstElementChild;
    expect(outer?.className).toBe('mk-row mk-row--cols-2');
  });

  it('a more local :::left wrapper inside a cell overrides the row-level align=center (locality wins)', () => {
    const { container } = render(
      renderMark(
        [
          '::::row{cols=2 align=center}',
          ':::left',
          'opted-out cell',
          ':::',
          '',
          'default cell',
          '::::',
        ].join('\n'),
        defaultRegistry,
      ),
    );
    const rowWrapper = container.querySelector('.mk-align-center');
    expect(rowWrapper).not.toBeNull();
    const row = rowWrapper?.querySelector('.mk-row');
    expect(row).not.toBeNull();
    const localOverride = row?.querySelector('.mk-layout.mk-align-left');
    expect(localOverride).not.toBeNull();
    expect(localOverride?.textContent).toContain('opted-out cell');
    // the local wrapper is a descendant of the row-level align wrapper,
    // not a sibling — this is what lets plain text-align inheritance,
    // rather than any CSS-specificity trick, decide the winner
    expect(rowWrapper?.contains(localOverride as Node)).toBe(true);
  });
});

describe('doc.css — row align cascades via inheritance, scoped to .mk-row only', () => {
  const css = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../doc.css'),
    'utf8',
  );

  it('sets text-align on the row for each of the three align values, scoped to > .mk-row', () => {
    expect(css).toContain('.mk-align-left > .mk-row {');
    expect(css).toContain('.mk-align-center > .mk-row {');
    expect(css).toContain('.mk-align-right > .mk-row {');
  });
});
