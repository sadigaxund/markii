import type { ComponentType, ReactNode } from 'react';
import type { FailureKind, ValueStatus } from '@markii/runtime';

/**
 * Attributes parsed off a directive, e.g. `{type=warning title="Careful"}`.
 * A bare attribute (present but valueless, e.g. `{collapsed}`) arrives as
 * `null`. A key that was never written is simply absent from the object.
 *
 * One key is special: `data` (docs/scripting.md — "`{data=stars}` feeds it to a
 * component"). The renderer intercepts `data` before a component ever sees
 * `attributes` — it is resolved against the value store and delivered as
 * the separate `data`/`dataStatus` props below, never left behind as a raw
 * string in `attributes`. See `render.tsx`'s `resolveDataAttribute`.
 */
export type DirectiveAttributes = Record<string, string | null | undefined>;

/**
 * Props every registry component receives. Attributes arrive as raw
 * strings (or null for bare attributes) — components are responsible for
 * parsing, validating, and defaulting their own attributes; `children` is
 * the directive's inner markdown, already rendered to React elements.
 *
 * `data`/`dataStatus` are populated only when the directive had a `data=`
 * attribute (§8): `data` is the resolved JS value from the value store
 * (`undefined` if the store has no such entry, or none was provided),
 * `dataStatus` mirrors its freshness (`@markii/runtime`'s `ValueStatus`).
 * Both are simply absent — not merely falsy — when the directive had no
 * `data=` attribute at all, so a component can tell "no binding requested"
 * apart from "binding requested but missing".
 *
 * `dataError`/`dataFailureKind` describe HOW a binding failed, for the same
 * quiet presentation `:value[...]` gives an inline value: a tooltip plus a
 * CSS class hook, never body text (AGENTS.md's cleanliness principle — the
 * rendered page never shows an error dump). `dataError` is the underlying
 * message the failing script produced, if any; `dataFailureKind` is
 * `@markii/runtime`'s closed `FailureKind` classification, supplied ONLY for
 * a genuine `dataStatus: 'error'` — a plain `'missing'` binding never
 * invents one, even if the stored root entry happened to carry a stale kind
 * from an earlier run. Both are optional and a component must degrade
 * gracefully when they are absent (a hand-built store or a pre-taxonomy
 * persisted value may carry neither).
 */
export interface MarkComponentProps {
  attributes: DirectiveAttributes;
  children?: ReactNode;
  data?: unknown;
  dataStatus?: ValueStatus;
  dataError?: string;
  dataFailureKind?: FailureKind;
}

/**
 * One registry entry: the component that renders a directive, plus whether
 * it is meant to be used inline (text directive, `:name[...]`) vs as a
 * block (leaf/container directive, `::name{...}` / `:::name{...} ... :::`).
 * `inline` is descriptive metadata for pack authors and tooling; the
 * renderer itself does not require it to place the component correctly,
 * since every component controls its own root element.
 */
export interface RegistryEntry {
  component: ComponentType<MarkComponentProps>;
  inline?: boolean;
}

/**
 * One alias: a second name for an existing registry component, optionally
 * carrying preset attributes. `warn` standing for `callout{type=warning}` is
 * the canonical example — the shorthand an app or a pack wants to offer
 * without shipping a second component that duplicates the first.
 *
 * Aliases are REGISTRY-level, i.e. app/pack configuration, and are never
 * definable inside a note: a note that could define its own names would be a
 * preprocessor in disguise, which the format rules out. A reader who opens
 * the raw `.mk.md` in any editor sees directive names whose meaning is fixed
 * by the host, not by an invisible macro block further up the file.
 */
export interface RegistryAlias {
  /** The registry name this alias stands for. */
  name: string;
  /**
   * Attributes the target receives unless the author wrote them. Author-
   * written attributes always win — closest to the text wins — so a preset
   * is a default, never an override.
   */
  attributes?: DirectiveAttributes;
}

/** Alias name -> what it stands for. */
export type RegistryAliases = Record<string, RegistryAlias>;

/**
 * The key an alias table hangs off a `Registry` under.
 *
 * A SYMBOL rather than a string key, because a `Registry` is a map from
 * directive names to entries and every string key is therefore a directive
 * name — a string key like `'aliases'` would collide with a perfectly legal
 * component of that name, and would show up in `Object.keys(registry)` for
 * every host that enumerates the registry to list what is installed. A
 * symbol collides with nothing: directive names are strings, so no document
 * can ever address it, and `Object.keys`/`Object.entries`/`JSON.stringify`
 * skip it while `Object.assign` (and therefore `mergeRegistries`) still
 * carries it across. It also keeps `Registry` backward-compatible — an
 * existing plain-object registry stays valid, alias-free.
 */
export const REGISTRY_ALIASES: unique symbol = Symbol(
  'markii.registry.aliases',
);

/**
 * Directive name -> component registration, plus an optional alias table
 * under the `REGISTRY_ALIASES` symbol (see `createRegistry`).
 */
export interface Registry {
  [name: string]: RegistryEntry;
  [REGISTRY_ALIASES]?: RegistryAliases;
}

/**
 * Reads a registry's alias table, or `undefined` when it has none. The
 * table is returned as-is (not copied) — treat it as read-only.
 */
export function registryAliases(
  registry: Registry,
): RegistryAliases | undefined {
  return registry[REGISTRY_ALIASES];
}

/**
 * Combines alias tables left-to-right into one null-prototype map, later
 * tables winning per NAME (not wholesale) — the same last-wins-per-key
 * semantics `mergeRegistries` gives components, so merging a pack that
 * defines `warn` into an app that defines `info` yields both. Returns
 * `undefined` when no input carried any aliases at all, so an alias-free
 * merge produces an alias-free registry rather than an empty table.
 */
function mergeAliasTables(
  tables: (RegistryAliases | undefined)[],
): RegistryAliases | undefined {
  const present = tables.filter((table) => table !== undefined);
  if (present.length === 0) return undefined;

  const merged = Object.create(null) as RegistryAliases;
  for (const table of present) {
    // `Object.keys` (own enumerable string keys only) assigned onto a
    // null-prototype target: an alias named `__proto__` becomes an ordinary
    // own property here rather than reaching a prototype setter, and an
    // alias named `constructor`/`toString` shadows nothing, because there is
    // no prototype to shadow.
    for (const name of Object.keys(table)) merged[name] = table[name]!;
  }
  return merged;
}

/**
 * Creates a Registry from a plain object of entries, plus an optional alias
 * table. The returned map has a `null` prototype so a directive named
 * `constructor`, `toString`, `valueOf`, `hasOwnProperty`, etc. cannot
 * resolve to an inherited `Object.prototype` member — only entries actually
 * registered here are ever found (see also the `Object.hasOwn` guard at the
 * lookup site in `render.tsx`, which protects even plain-object registries).
 * The alias table gets the same treatment (`mergeAliasTables`), and aliases
 * already carried by `entries` are kept, with `aliases` winning per name.
 */
export function createRegistry(
  entries: Registry = {},
  aliases?: RegistryAliases,
): Registry {
  const registry = Object.assign(Object.create(null) as Registry, entries);
  const merged = mergeAliasTables([registryAliases(entries), aliases]);
  if (merged) registry[REGISTRY_ALIASES] = merged;
  return registry;
}

/**
 * Merges any number of registries, later ones taking precedence. The
 * returned map has a `null` prototype, matching `createRegistry`, so the
 * public API is symmetric: every `Registry` this module hands back is safe
 * from prototype-chain collisions regardless of which factory produced it.
 *
 * Alias tables merge per NAME, exactly like components — not wholesale.
 * `Object.assign` alone would let the last registry that happens to define
 * ANY alias silently drop every alias defined earlier, which is not what
 * "later ones take precedence" means for components, so the table is
 * recomputed here and reattached.
 */
export function mergeRegistries(...registries: Registry[]): Registry {
  const merged = Object.assign(
    Object.create(null) as Registry,
    ...registries,
  ) as Registry;
  const aliases = mergeAliasTables(registries.map(registryAliases));
  if (aliases) merged[REGISTRY_ALIASES] = aliases;
  else delete merged[REGISTRY_ALIASES];
  return merged;
}

/**
 * Reads `entry.component`, or `undefined` if `entry` is nullish OR the read
 * itself throws.
 *
 * `component` is a plain data property on every well-behaved
 * `RegistryEntry`, but nothing stops a hand-built registry from defining it
 * as a throwing getter (or handing over a `Proxy` that traps the read) —
 * exactly the same "hostile registry configuration" class `isFormMismatch`
 * in `render.tsx` already guards for `entry.inline`. `component` is looked
 * up far more often than `inline` (every directive, both here and in
 * `render.tsx`'s `renderDirectiveContent`), so it gets its own shared,
 * exported accessor rather than a second private wrapper: a throwing read
 * degrades to "no component here", identical to a genuinely absent one —
 * never an exception escaping React's render phase (docs/spec.md
 * requirement 4).
 */
export function readRegistryComponent(
  entry: RegistryEntry | undefined,
): ComponentType<MarkComponentProps> | undefined {
  if (!entry) return undefined;
  try {
    return entry.component ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether `registry` has a real, usable component under `name`.
 *
 * `Object.hasOwn` rather than `name in registry` / bare indexing, for the
 * same reason the renderer uses it: a directive named `constructor` must
 * miss, not resolve through the prototype chain. The `component == null`
 * half matches `render.tsx`'s own "is this entry usable" test, so a broken
 * entry (`{ component: undefined }`, e.g. from a half-loaded pack) counts as
 * absent HERE too — which is what lets an alias still stand in for a name
 * whose entry is broken, instead of both paths failing at once. The read
 * itself goes through `readRegistryComponent`, so a throwing `component`
 * getter counts as broken too, rather than escaping alias resolution.
 */
function hasComponent(registry: Registry, name: string): boolean {
  return (
    Object.hasOwn(registry, name) &&
    readRegistryComponent(registry[name]) != null
  );
}

/**
 * Merges an alias's preset attributes under the author's own, author winning
 * on collision — "closest to the text wins", the same instinct that makes a
 * local declaration beat a default everywhere else.
 *
 * Built by ASSIGNING each key onto a fresh object, exactly the way
 * `render.tsx`'s `parseAttributes` builds the author's own attribute map, so
 * both sides of the merge get identical treatment of hostile keys: a preset
 * key of `__proto__` hits `Object.prototype`'s setter and is dropped for a
 * string value (never becoming an own property, never polluting anything),
 * precisely as it already is when an author writes `{__proto__=x}` in the
 * document. A preset named `constructor` becomes an inert own data property,
 * again identically to the author-written case.
 */
function mergeAliasAttributes(
  preset: DirectiveAttributes | undefined,
  author: DirectiveAttributes,
): DirectiveAttributes {
  if (!preset) return author;
  const result: DirectiveAttributes = {};
  for (const [key, value] of Object.entries(preset)) result[key] = value;
  for (const [key, value] of Object.entries(author)) result[key] = value;
  return result;
}

/** A directive name and attributes after alias resolution (see `resolveDirectiveAlias`). */
export interface ResolvedDirective {
  name: string;
  attributes: DirectiveAttributes;
}

/**
 * Resolves one directive name through the registry's alias table, returning
 * the name the renderer should actually look up plus the attributes it
 * should pass on. Four rules, in order:
 *
 * 1. **A real component wins.** If `name` is registered with a usable
 *    component, it is returned untouched — an alias can never shadow a real
 *    entry, so installing a pack that aliases `callout` cannot hijack the
 *    `callout` an app already registered.
 * 2. **No alias, no change.** An unaliased name passes straight through.
 * 3. **One hop only.** The alias's target is returned as-is; this function
 *    is never re-entered for it. The target is then resolved exactly as if
 *    the author had typed it — including the unknown-directive fallback,
 *    which is therefore reported against the TARGET name (an alias pointing
 *    at a missing component reads as "unknown component `card`", the honest
 *    thing for whoever has to install it). An alias pointing at another
 *    alias therefore lands on the fallback rather than chaining: chains
 *    cannot be rejected at `createRegistry` time (a later `mergeRegistries`
 *    could always introduce one), so the guarantee is enforced here, at the
 *    only place resolution happens.
 * 4. **Author attributes win** over the alias's presets
 *    (`mergeAliasAttributes`).
 *
 * Never throws, and defends against a hand-built registry: a missing or
 * non-string target name is treated as no alias at all, so a malformed
 * alias degrades to the ordinary unknown-directive path rather than
 * rendering something arbitrary.
 */
export function resolveDirectiveAlias(
  registry: Registry,
  name: string,
  attributes: DirectiveAttributes,
): ResolvedDirective {
  if (hasComponent(registry, name)) return { name, attributes };

  const aliases = registryAliases(registry);
  if (!aliases || !Object.hasOwn(aliases, name)) return { name, attributes };

  const alias = aliases[name];
  if (typeof alias?.name !== 'string' || alias.name === '') {
    return { name, attributes };
  }

  return {
    name: alias.name,
    attributes: mergeAliasAttributes(alias.attributes, attributes),
  };
}
