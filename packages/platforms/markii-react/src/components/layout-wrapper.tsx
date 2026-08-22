import type { ComponentType, ReactElement } from 'react';
import type { MarkComponentProps } from '../registry.js';

/**
 * The closed set of layout-wrapper container names (docs/format.md): six
 * aliases of the one shared implementation below (`createLayoutWrapper`).
 * Unlike the `width`/`align` *attributes* (`layout.ts`), these are directive
 * *names* — the only way to carry a §4 layout preset to plain markdown that
 * an attribute mechanism structurally cannot reach: a GFM table or a bare
 * `![]()` image has no `{...}` to write `width=`/`align=` into. There is
 * deliberately no `normal` alias (the default needs no wrapper at all) and
 * no attribute-bearing form.
 *
 * `left` exists even though it mostly matches the ambient default: it is
 * the only way to OVERRIDE an alignment inherited from an enclosing scope
 * (e.g. `:::row{align=center}`'s cascade into its cells, `doc.css`'s
 * `.mk-align-center > .mk-row` rule) back to left alignment inside one
 * cell — a bare, unwrapped paragraph has no directive of its own to attach
 * such an override to.
 */
/*
 * Deliberately NOT built on the registry alias mechanism (`registry.ts`),
 * despite "alias" appearing in the sentence below in its ordinary English
 * sense. A registry alias maps a name onto ANOTHER REGISTERED NAME plus
 * preset attributes; these five map onto no shared public name, so aliasing
 * them would mean inventing one (`:::layout{preset=wide}`) and adding it to
 * the format — more public surface, not less. The preset attributes would
 * also have to be `width=`/`align=`, which the renderer intercepts BEFORE a
 * component sees them, producing `<div class="mk-width-wide">` around the
 * component instead of the single `<div class="mk-layout mk-width-wide">`
 * these emit — different DOM, and `doc.css`'s `.mk-layout > * + *` rhythm
 * rule would stop matching. Five two-line registry entries sharing one
 * implementation is the simpler arrangement; leave it alone.
 */
export const LAYOUT_WRAPPER_PRESETS = [
  'center',
  'left',
  'right',
  'wide',
  'narrow',
  'full',
] as const;

/** One of the six closed layout-wrapper preset names. */
export type LayoutWrapperPreset = (typeof LAYOUT_WRAPPER_PRESETS)[number];

/**
 * Preset -> class string. Null-prototype, mirroring `layout.ts`'s
 * `WIDTH_CLASSES`/`ALIGN_CLASSES`: a lookup can never resolve through the
 * prototype chain to an inherited `Object.prototype` member. `preset` is
 * always one of the five literals above — bound once at registration time
 * by `createLayoutWrapper`, never derived from directive input — so this is
 * defense in depth rather than a reachable path, but it keeps the same
 * defensive shape every other closed-enum lookup in this codebase uses.
 *
 * `center`/`left`/`right` reuse the existing `mk-align-*` classes
 * (`layout.ts`'s `ALIGN_CLASSES`, `doc.css`'s alignment rules);
 * `wide`/`narrow`/`full` reuse the existing `mk-width-*` classes.
 * `mk-layout` is the one class every preset adds on top, carrying the
 * wrapper-specific rhythm/table rules in `doc.css` that don't belong on the
 * bare `width`/`align` attribute-interception wrapper in `render.tsx`.
 */
const WRAPPER_CLASSES: Record<string, string> = Object.assign(
  Object.create(null) as Record<string, string>,
  {
    center: 'mk-layout mk-align-center',
    left: 'mk-layout mk-align-left',
    right: 'mk-layout mk-align-right',
    wide: 'mk-layout mk-width-wide',
    narrow: 'mk-layout mk-width-narrow',
    full: 'mk-layout mk-width-full',
  } satisfies Record<LayoutWrapperPreset, string>,
);

/**
 * Creates the registry component for one of docs/format.md's six layout-
 * wrapper container names — `:::center`, `:::left`, `:::right`, `:::wide`,
 * `:::narrow`, `:::full`. One shared implementation, bound to `preset` at
 * registration time (see `components/index.ts`), so six registry entries
 * share one function body instead of six near-identical copies.
 *
 * Deliberately never reads `attributes`: docs/format.md gives these wrappers
 * no attribute-bearing form. Writing one anyway (`:::center{foo=bar}`) is
 * valid directive syntax, but `foo` is simply never looked at — the same as
 * any attribute a component doesn't declare. `width`/`align` written on a
 * wrapper are intercepted earlier, by `render.tsx`'s reserved-attribute
 * handling (`layout.ts`), before this component ever runs; see
 * `layout-wrapper.test.tsx` for the resulting (outer-wrapper) DOM shape.
 *
 * Never throws: `preset` is always one of the six closed literals, and an
 * empty body (`children` absent) is valid — an empty `<div>` is not an
 * error condition. No outer margin (Architecture rule 4): `.doc > * + *`
 * spaces this wrapper against its siblings, and `.mk-layout > * + *`
 * (`doc.css`) restores rhythm for whatever plain markdown sits inside it.
 */
export function createLayoutWrapper(
  preset: LayoutWrapperPreset,
): ComponentType<MarkComponentProps> {
  const className = WRAPPER_CLASSES[preset] ?? 'mk-layout';

  function LayoutWrapper({ children }: MarkComponentProps): ReactElement {
    return <div className={className}>{children}</div>;
  }

  LayoutWrapper.displayName = `LayoutWrapper(${preset})`;
  return LayoutWrapper;
}
