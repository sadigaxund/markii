import { Fragment, isValidElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import {
  toHast,
  nodeToHast,
  parseMetaAttributes,
  isValidScriptName,
  isBareAttribute,
} from '@markii/core';
import type { MarkNode } from '@markii/core';
import type {
  FailureKind,
  ValueStatus,
  ValueStore,
  VaultStore,
} from '@markii/runtime';
import type { Element as HastElement, Root as HastRoot } from 'hast';
import type {
  DirectiveAttributes,
  Registry,
  RegistryEntry,
} from './registry.js';
import { readRegistryComponent, resolveDirectiveAlias } from './registry.js';
import { resolveLayoutAttributes } from './layout.js';
import { ScriptMarker } from './components/script-marker.js';
import { UnknownDirective } from './components/unknown-directive.js';
import { ValueDirective } from './components/value-directive.js';
import { resolveScopedPath } from './store-path.js';

function parseAttributes(json: string | undefined): DirectiveAttributes {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    const result: DirectiveAttributes = {};
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (typeof value === 'string' || value === null || value === undefined) {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

interface DirectiveElementProps {
  'data-mk-name'?: string;
  'data-mk-attrs'?: string;
  'data-mk-kind'?: string;
  children?: ReactNode;
}

/**
 * What a container component can learn about one of its own React
 * `children` elements, if that element is one of `renderMark`'s own
 * not-yet-resolved directive placeholders — see `readDirectiveChild`.
 */
export interface DirectiveChild {
  name: string;
  attributes: DirectiveAttributes;
  children?: ReactNode;
}

/**
 * Reads a directive name/attributes/pre-rendered body back off `node`, if
 * `node` is one of `renderMark`'s own directive elements — returns
 * `undefined` for anything else (plain text, a fragment, an element
 * belonging to some other component). Never throws.
 *
 * Exists because every `<mk-directive>` hast tag becomes exactly one shared
 * React component (`DirectiveElement`, built by `createDirectiveElement`
 * above) regardless of which directive name it carries — the name-specific
 * registry component (e.g. `Tab`) is only produced when React actually
 * *invokes* that element during reconciliation, which for a child element
 * hasn't happened yet by the time its parent's own render function runs.
 * So a container component that needs to recognize "one of my children is a
 * `tab` directive" (e.g. `Tabs`, docs/spec.md's tabs/tab pair) cannot do it by
 * checking `child.type` — every directive child shares the same `type`
 * until rendered. This helper is the supported way to do that recognition
 * instead: it reads the same `data-mk-name`/`data-mk-attrs` props
 * `createDirectiveElement` itself reads, parsed with the same
 * `parseAttributes` used for every other directive, so a container
 * component never has to know the wire encoding (JSON-in-a-data-attribute)
 * to use it.
 */
export function readDirectiveChild(
  node: ReactNode,
): DirectiveChild | undefined {
  if (!isValidElement<DirectiveElementProps>(node)) return undefined;
  const name = node.props['data-mk-name'];
  if (!name) return undefined;
  return {
    name,
    attributes: parseAttributes(node.props['data-mk-attrs']),
    children: node.props.children,
  };
}

/** The reserved directive name for render-time value interpolation (§8: `:value[name]`). */
const VALUE_DIRECTIVE_NAME = 'value';

/** The one attribute key that binds a directive to the value store instead of passing through as a raw string (§8: `data=name`). */
const DATA_ATTRIBUTE_KEY = 'data';

interface ResolvedDataBinding {
  attributes: DirectiveAttributes;
  data?: unknown;
  dataStatus?: ValueStatus;
  dataError?: string;
  dataFailureKind?: FailureKind;
}

/**
 * Splits a `data=<name>` attribute (if present) off `attributes`, resolves
 * `<name>` against `store`/`vault` — `<name>` may be a dotted path
 * (`repo.stars`) reaching into a stored object/array, or a bare name, and an
 * `@`-prefixed name (`@gh.stars`) routes at `vault` instead of `store` (§8)
 * — via `resolveScopedPath` (`./store-path`) — and returns the resolved
 * binding plus the remaining attributes (every other attribute is
 * untouched — this only ever special-cases the `data` key). Never throws:
 * no store/vault, an empty/bare `data` attribute, an unknown root name, and
 * an unresolved path segment all degrade to `dataStatus: 'missing'` with
 * `data: undefined`, the same graceful-degradation spirit as the
 * unknown-directive fallback.
 *
 * Failure detail (`dataError`/`dataFailureKind`) is carried alongside the
 * value so a data-bound component can surface it the way `ValueDirective`
 * already does — tooltip + class hook, never body text. `dataFailureKind` is
 * gated to a genuine `'error'` resolution HERE, in the one resolver, rather
 * than in each component: a `'missing'` resolution must never present a
 * failure kind even when `resolveScopedPath` carried one through from the
 * root entry of a partially-resolved dotted path (see `store-path.ts`'s
 * `walkSegments`) — exactly the rule `ValueDirective` applies to its own
 * resolution.
 */
function resolveDataAttribute(
  attributes: DirectiveAttributes,
  store: ValueStore | undefined,
  vault: VaultStore | undefined,
): ResolvedDataBinding {
  if (!Object.hasOwn(attributes, DATA_ATTRIBUTE_KEY)) {
    return { attributes };
  }

  const { [DATA_ATTRIBUTE_KEY]: rawName, ...rest } = attributes;
  if (!rawName) {
    return { attributes: rest, data: undefined, dataStatus: 'missing' };
  }

  const resolved = resolveScopedPath({ store, vault }, rawName);
  return {
    attributes: rest,
    data: resolved.value,
    dataStatus: resolved.status,
    dataError: resolved.error,
    dataFailureKind:
      resolved.status === 'error' ? resolved.failureKind : undefined,
  };
}

// hast-util-to-jsx-runtime's `Components` map is keyed by `JSX.IntrinsicElements`
// (see its readme: "Each key is a tag name typed in JSX.IntrinsicElements").
// Registering our marker tag there is the supported way to give it a typed
// `components` entry below, without a cast or `any`.
declare global {
  namespace JSX {
    interface IntrinsicElements {
      'mk-directive': DirectiveElementProps;
    }
  }
}

/**
 * The `data-mk-kind` value `@markii/core`'s `toHast` writes for a TEXT
 * (inline) directive — `:name[...]`. The other two values are
 * `'leafDirective'` (`::name{...}`) and `'containerDirective'`
 * (`:::name{...} ... :::`), both of which are block forms; anything else
 * (including an absent attribute, e.g. a hand-built hast tree) is treated as
 * block, matching the pre-existing `kind !== 'textDirective'` test.
 */
const TEXT_DIRECTIVE_KIND = 'textDirective';

/**
 * Whether `entry` is registered as a BLOCK component but the directive was
 * written inline — docs/spec.md's form/kind mismatch, the one direction that
 * must degrade rather than render.
 *
 * The source of truth is deliberately `RegistryEntry.inline`, the registry's
 * own kind information, and nothing else. `@markii/stdlib`'s `ComponentKind`
 * is where `defaultRegistry` DERIVES that flag from (see
 * `components/index.ts`'s `inlineFromContract`), but the renderer must not
 * consult the contracts directly: a host is free to register its own
 * component under a standard name, and the standard contract would then be
 * describing somebody else's component. The registry entry always describes
 * the component actually registered.
 *
 * Only an EXPLICIT `inline: false` counts. `inline` is optional and
 * documented as descriptive metadata, so `undefined` means "this registration
 * says nothing about kind" — and a registration that says nothing must keep
 * working exactly as it did before this rule existed. Degradation happens
 * only where the mismatch is genuinely knowable.
 *
 * The reverse direction — an inline component written as a leaf or container
 * (`::kbd{}`, `:::badge ... :::`) — deliberately stays permissive. The two
 * directions are not symmetric in consequence: a `<div>` inside a `<p>` is
 * restructured by every HTML parser (the paragraph is closed and reopened),
 * so the DOM a reader ends up with is not the tree the renderer built, and a
 * serialize/re-parse round trip (SSR, copy as HTML, an export) silently
 * changes the document's structure. Phrasing content sitting in block flow
 * is at worst non-conforming: `<span><p>x</p></span>` is parsed exactly as
 * written, renders correctly, and round-trips. Degrading it would buy no
 * correctness and would cost content — the author's inner markdown would be
 * demoted into a fallback box over a purely notional violation — so the rule
 * is scoped to the direction that actually corrupts the tree.
 *
 * Reading the flag is wrapped, because this is a NEW property read on a
 * host-supplied object: a registry entry defined with a throwing `inline`
 * getter (or a `Proxy` trapping it) would otherwise turn a rendering
 * question into an exception escaping React's render phase, which
 * docs/spec.md requirement 4 forbids. A read that fails is simply kind
 * information we do not have, so it fails PERMISSIVE — identical to an
 * absent flag, and identical to how this renderer behaved before the rule
 * existed.
 */
function isFormMismatch(
  entry: RegistryEntry,
  kind: string | undefined,
): boolean {
  if (kind !== TEXT_DIRECTIVE_KIND) return false;
  try {
    return entry.inline === false;
  } catch {
    return false;
  }
}

/**
 * Renders one directive's content (registry component, `:value[...]`
 * built-in, or the unknown-directive fallback) given its already
 * layout-stripped `attributes` — the part of `DirectiveElement` that does
 * NOT know about layout wrapping, split out so `createDirectiveElement` can
 * wrap its result in a layout `<div>` uniformly, without duplicating this
 * resolution logic at every return point. This is the only place a
 * directive name is resolved; it never throws.
 */
function renderDirectiveContent(
  name: string,
  kind: string | undefined,
  attributes: DirectiveAttributes,
  children: ReactNode,
  registry: Registry,
  store: ValueStore | undefined,
  vault: VaultStore | undefined,
): ReactElement {
  // `:value[name]` (§8) is a renderer built-in, resolved before any
  // registry lookup — like the unknown-directive fallback, it is not
  // something a pack can register over; it is part of the render-time
  // interpolation contract itself.
  if (name === VALUE_DIRECTIVE_NAME) {
    return (
      <ValueDirective store={store} vault={vault}>
        {children}
      </ValueDirective>
    );
  }

  // `Object.hasOwn` (rather than `registry[name]` / `name in registry`)
  // guards against a directive named `constructor`, `toString`,
  // `valueOf`, `hasOwnProperty`, etc. resolving through the prototype
  // chain to an inherited `Object.prototype` member instead of falling
  // through to the unknown-directive fallback (Architecture rule 3: unknown
  // directives never throw). The `Component == null` check below is a
  // second belt-and-suspenders guard for the same class of bug — it must
  // be a nullish check rather than `typeof ... !== 'function'`, since
  // `React.memo`/`forwardRef`/`lazy` all produce a component whose
  // `typeof` is `'object'`, not `'function'`, and TypeScript's
  // `ComponentType` accepts all of them.
  const entry = Object.hasOwn(registry, name) ? registry[name] : undefined;

  // Both fallback paths below share one element choice: the fallback's FORM
  // follows the DIRECTIVE's form, never the component's kind. An inline
  // directive always gets the `<span>`-based marker, because whatever we
  // emit here lands inside the paragraph the directive was written in.
  const inline = kind === TEXT_DIRECTIVE_KIND;

  // `readRegistryComponent` (from `./registry.js`) reads `entry.component`
  // behind a try/catch, so a hand-built registry entry defining `component`
  // as a throwing getter (or a `Proxy` trapping the read) degrades to "no
  // component here" exactly like a genuinely missing one, instead of an
  // exception escaping React's render phase (docs/spec.md requirement 4) —
  // the same hostile-configuration guard `isFormMismatch` already gives
  // `entry.inline`. The `!entry` half of the guard below only narrows
  // `entry`'s type for the `isFormMismatch` call further down (a `Component`
  // can only be non-null when `entry` itself is defined); it never changes
  // behavior, since an undefined `entry` already yields a `null` `Component`.
  const Component = readRegistryComponent(entry);

  if (!entry || Component == null) {
    return (
      <UnknownDirective name={name || '(unnamed)'} inline={inline}>
        {children}
      </UnknownDirective>
    );
  }

  // A registered component written in a form its kind does not match
  // degrades to the same fallback INSTEAD of rendering — see
  // `isFormMismatch` for why this is one-directional. Checked after the
  // "is there a component at all" test so an unregistered name keeps
  // reporting itself as unregistered, which is the more useful of the two.
  if (isFormMismatch(entry, kind)) {
    return (
      <UnknownDirective
        name={name || '(unnamed)'}
        inline={inline}
        reason="form-mismatch"
      >
        {children}
      </UnknownDirective>
    );
  }

  const binding = resolveDataAttribute(attributes, store, vault);
  // `data`/`dataStatus` are only spread in when the directive actually had
  // a `data=` attribute (`'data' in binding`) — NOT whenever
  // `binding.data` happens to be defined. Without this check, JSX would
  // always pass `data`/`dataStatus` as explicit (if `undefined`) props,
  // so `'data' in props` inside a component would be `true` even for a
  // directive with no `data=` attribute at all, defeating the very
  // distinction `registry.ts`'s `MarkComponentProps` doc comment promises
  // ("absent — not merely falsy — when the directive had no `data=`
  // attribute").
  const dataProps =
    'data' in binding
      ? {
          data: binding.data,
          dataStatus: binding.dataStatus,
          dataError: binding.dataError,
          dataFailureKind: binding.dataFailureKind,
        }
      : {};
  return (
    <Component attributes={binding.attributes} {...dataProps}>
      {children}
    </Component>
  );
}

/**
 * Builds the React component used to replace every `<mk-directive>` hast
 * element (tagged by `@markii/core`'s `toHast`): resolves the registry's
 * alias table, then docs/format.md's
 * reserved layout-preset attributes (`width`/`align`) for EVERY directive,
 * inline or block, then delegates the rest of the work — registry lookup,
 * `:value[...]`, the unknown-directive fallback — to
 * `renderDirectiveContent`. Only a block (non-`textDirective`) directive
 * actually gets wrapped in a layout `<div>`; an inline directive's resolved
 * class, if any, is discarded. Never throws.
 *
 * Typed as a plain function (not React's `ComponentType`, whose declared
 * return type is the broader `ReactNode`) because hast-util-to-jsx-runtime's
 * `Components` map expects a component returning `JSX.Element | string |
 * null | undefined` — narrower than `ReactNode`. This component always
 * returns a `ReactElement`, so the narrower signature is also the honest one.
 */
function createDirectiveElement(
  registry: Registry,
  store: ValueStore | undefined,
  vault: VaultStore | undefined,
): (props: DirectiveElementProps) => ReactElement {
  return function DirectiveElement(props: DirectiveElementProps): ReactElement {
    const written = props['data-mk-name'] ?? '';
    const kind = props['data-mk-kind'];
    const rawAttributes = parseAttributes(props['data-mk-attrs']);

    // Registry aliases (`registry.ts`) are resolved FIRST, so everything
    // downstream — layout interception, `data=` binding, the registry
    // lookup, the unknown fallback — treats the resolved name and merged
    // attributes exactly as if the author had written them. In particular
    // an alias preset of `width=wide` is intercepted by
    // `resolveLayoutAttributes` below like any author-written `width`,
    // rather than reaching a component as a stray attribute.
    //
    // `value` is excluded: `:value[...]` is a renderer built-in
    // (`renderDirectiveContent`), not a registry entry, so an alias NAMED
    // `value` is inert — it can no more be aliased over than it can be
    // registered over. An alias whose TARGET is `value` does reach the
    // built-in, which is simply rule 3 of `resolveDirectiveAlias`: the
    // target resolves as if the author had typed it.
    const { name, attributes: aliasedAttributes } =
      written === VALUE_DIRECTIVE_NAME
        ? { name: written, attributes: rawAttributes }
        : resolveDirectiveAlias(registry, written, rawAttributes);

    // Reserved layout keys (docs/format.md: `width`/`align`) are stripped for
    // EVERY directive, inline or block — a text directive's component must
    // never see them either. Intercepted here, before the registry lookup
    // inside `renderDirectiveContent`, so it applies identically to a
    // registered component, the unknown-directive fallback, and a directive
    // named `constructor`/`toString`/`__proto__`.
    const isBlockDirective = kind !== TEXT_DIRECTIVE_KIND;
    const { attributes, className: layoutClassName } =
      resolveLayoutAttributes(aliasedAttributes);

    const element = renderDirectiveContent(
      name,
      kind,
      attributes,
      props.children,
      registry,
      store,
      vault,
    );

    // The wrapper `<div>` applies ONLY to block directives (leaf/container),
    // and only when at least one layout class actually resulted. An inline
    // (`textDirective`) directive never gets a wrapper — a `<div>` inside a
    // paragraph would be invalid HTML and would break the `.doc > * + *`
    // rhythm rule — so its resolved `layoutClassName`, if any, is simply
    // discarded here; the reserved keys were already stripped above
    // regardless. This also keeps DOM output unchanged from before layout
    // presets existed for the overwhelmingly common case of a block
    // directive with no width/align.
    return isBlockDirective && layoutClassName ? (
      <div className={layoutClassName}>{element}</div>
    ) : (
      element
    );
  };
}

/** The hast/DOM attribute `@markii/core`'s `toHast` preserves a code fence's raw `meta` string onto (see `to-hast.ts`'s `preserveCodeMeta`). */
const CODE_META_ATTR = 'data-mk-meta';

/**
 * The bare-only meta attribute (docs/scripting.md) that opts a script marker into
 * rendering already-expanded. Bare-only like `@markii/core`'s `publish`: only
 * the genuinely valueless spelling (`{name=x open}`) counts — `open=true`,
 * `open=false`, and `open=""` are all different, unrecognized attributes and
 * must NOT open the marker (fail closed, per §8). Tested via `isBareAttribute`
 * against the raw meta string, not `attrs.open === ''`/`Object.hasOwn`
 * against the flattened `parseMetaAttributes` map — that map collapses a
 * bare key and an explicitly-valued `open=""` to the same `''`, which would
 * wrongly open for `open=""` too.
 */
const OPEN_ATTRIBUTE_KEY = 'open';

/** The first element child of `node` named `tagName`, or `undefined` if there is none (or `node` itself is absent). */
function findChildElement(
  node: HastElement | undefined,
  tagName: string,
): HastElement | undefined {
  if (!node) return undefined;
  for (const child of node.children) {
    if (child.type === 'element' && child.tagName === tagName) return child;
  }
  return undefined;
}

/** Reads the fence's language tag off the `language-<lang>` class mdast-util-to-hast's default `code` handler adds, or `''` if there is none. */
function getLanguage(codeNode: HastElement | undefined): string {
  const classNames = codeNode?.properties.className ?? [];
  for (const name of classNames) {
    if (typeof name === 'string' && name.startsWith('language-')) {
      return name.slice('language-'.length);
    }
  }
  return '';
}

/**
 * Reads a code element's exact fence body text back out of its hast text
 * children. `mdast-util-to-hast`'s `code` handler appends exactly one
 * trailing `"\n"` to a non-empty value when building the hast text node
 * (`handlers/code.js`: `node.value ? node.value + '\n' : ''`) — stripping
 * that single trailing newline back off recovers the original fenced-code
 * source exactly, byte-for-byte, rather than re-deriving it from anywhere
 * else.
 */
function getCodeText(codeNode: HastElement | undefined): string {
  if (!codeNode) return '';
  let text = '';
  for (const child of codeNode.children) {
    if (child.type === 'text') text += child.value;
  }
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

interface PreElementProps {
  node?: HastElement;
  children?: ReactNode;
}

/**
 * Overrides hast-util-to-jsx-runtime's default `<pre>` conversion so a
 * script code block (docs/scripting.md: a fence whose meta carries a
 * `{name=...}` attribute group) renders as a collapsed, expandable
 * `ScriptMarker` instead of a raw `<pre><code>` wall. Reads the raw hast
 * node (passed via `toJsxRuntime`'s `passNode` option) purely to reach the
 * `data-mk-meta` string `@markii/core`'s `toHast` stashed on the nested
 * `<code>` element — meta is otherwise dropped by the default hast
 * conversion — and reuses `@markii/core`'s own `parseMetaAttributes` to
 * read it, rather than re-implementing the brace/quote/token grammar here.
 * Never throws: any malformed/unparsable meta, or a code block with no
 * `name` attribute at all, falls through to ordinary `<pre>{children}</pre>`
 * rendering — the same graceful-degradation spirit as the unknown-directive
 * fallback (Architecture rule 3).
 *
 * The `name` must also pass `@markii/core`'s `isValidScriptName` (docs/spec.md
 * §8's `[A-Za-z_][A-Za-z0-9_-]*` charset — dots in particular are reserved,
 * since `data=`/`:value[]` read a dot as path traversal). A block whose name
 * fails that check is NOT a script: `extractScripts` skips it, so it can
 * never run, and folding it to a `⚙ name` marker here would advertise a
 * runnable block that the runtime will never execute. It stays ordinary
 * highlighted code instead — the same display-only degradation the spec
 * gives a fence with no `name` at all, and never an error.
 */
function PreElement({ node, children }: PreElementProps): ReactElement {
  try {
    const codeNode = findChildElement(node, 'code');
    const meta = codeNode?.properties[CODE_META_ATTR];
    if (typeof meta === 'string') {
      const attrs = parseMetaAttributes(meta);
      const name = attrs.name;
      if (name && isValidScriptName(name)) {
        return (
          <ScriptMarker
            name={name}
            lang={getLanguage(codeNode)}
            src={attrs.src || undefined}
            code={getCodeText(codeNode)}
            open={isBareAttribute(meta, OPEN_ATTRIBUTE_KEY)}
          />
        );
      }
    }
  } catch {
    // Malformed meta degrades to ordinary code-block rendering below —
    // script detection must never be able to break rendering.
  }
  return <pre>{children}</pre>;
}

/**
 * Converts an already-sanitized hast tree to a React element tree via
 * hast-util-to-jsx-runtime, with directive elements swapped for registry
 * components (or the unknown-directive fallback) and script fences folded
 * into `ScriptMarker`. The ONE shared `toJsxRuntime` call site for both
 * `renderMark` (whole document) and `renderMarkNode` (a single node) — kept
 * to exactly one place so the two entry points cannot drift apart on which
 * `components` map, or which `toJsxRuntime` options, either one uses.
 */
function hastToReactTree(
  hastTree: HastRoot,
  registry: Registry,
  store: ValueStore | undefined,
  vault: VaultStore | undefined,
): ReactElement {
  const DirectiveElement = createDirectiveElement(registry, store, vault);
  return toJsxRuntime(hastTree, {
    Fragment,
    jsx,
    jsxs,
    passNode: true,
    components: { 'mk-directive': DirectiveElement, pre: PreElement },
  }) as ReactElement;
}

/**
 * The shared "failed to render" fallback box — identical markup/class names
 * for `renderMark` and `renderMarkNode`, so a document-level failure and a
 * node-level failure degrade indistinguishably (Architecture rule 3's
 * never-throw spirit extended to the renderer's own internal errors, not
 * just unknown directives).
 */
function renderFailureFallback(error: unknown): ReactElement {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="mk-unknown mk-unknown--block" role="alert">
      <p className="mk-unknown__label">failed to render document</p>
      <pre className="mk-unknown__content">{message}</pre>
    </div>
  );
}

/**
 * Renders Super Markdown text to a React element tree using `registry` to
 * resolve directive names. Pipeline: `@markii/core`'s `toHast` (parse -> tag
 * directive nodes -> remark-rehype -> sanitize URLs) -> `hastToReactTree`
 * (React elements), with directive elements swapped for registry components
 * (or the unknown-directive fallback) along the way. Never throws: parsing
 * is tolerant by construction, and unresolved directive names always render
 * a fallback rather than fail.
 *
 * `store` is the note's value store (`@markii/runtime`, §8's pure read
 * path) — optional, matching how a missing/absent value degrades
 * gracefully rather than failing: with no store, `:value[name]` renders its
 * missing-value marker and every `data=name` attribute resolves to
 * `dataStatus: 'missing'`, but the document still renders completely.
 *
 * `vault` is the optional app-scoped read seam (`@markii/runtime`'s
 * `VaultStore`, §8's "vault-published values") that an `@`-prefixed name
 * (`data=@gh.stars`, `:value[@gh.stars]`) resolves against instead of
 * `store` — "bare name = mine, `@name` = the vault's". Reading the vault is
 * render-time and pure, exactly like reading `store`: it executes nothing
 * and needs no grant. With no `vault` supplied, every `@name` degrades to
 * `dataStatus`/status `'missing'` the same way an absent `store` degrades a
 * bare name — the document still renders completely.
 *
 * Both `store` and `vault` are threaded as plain function arguments (not a
 * wrapping React context provider) to match `registry`, the entry point's
 * other piece of configuration — `renderMark` is a plain function called
 * directly to produce a `ReactElement`, not a component mounted inside its
 * own tree, so there is no existing provider layer for a context to hook
 * into here.
 */
export function renderMark(
  text: string,
  registry: Registry,
  store?: ValueStore,
  vault?: VaultStore,
): ReactElement {
  try {
    const hastTree = toHast(text);
    return hastToReactTree(hastTree, registry, store, vault);
  } catch (error) {
    return renderFailureFallback(error);
  }
}

/**
 * The block-level twin of `renderMark`: renders one already-parsed mdast
 * node (`@markii/core`'s `MarkNode` — e.g. a single top-level child of a
 * `parse`d document) instead of a whole document's text. Same registry
 * resolution (`createDirectiveElement`/`renderDirectiveContent`, including
 * the unknown-directive and `Object.prototype`-name fallbacks), same
 * `:value[...]`/`data=` store and vault resolution, same script-fence
 * folding into `ScriptMarker` (`PreElement`), same never-throw "failed to
 * render document" fallback box, and the same purity guarantee — this
 * function has no state and no side effects, exactly like `renderMark`.
 *
 * Pipeline: `@markii/core`'s `nodeToHast` (deep-clones `node`, then the SAME
 * tag/preserve-meta/remark-rehype/sanitize steps `toHast` runs) ->
 * `hastToReactTree`, the one shared `toJsxRuntime` call site both this
 * function and `renderMark` use, so the two cannot diverge on which
 * `components` map or options either one passes. Positions on any element
 * that carries them come straight from the parser (`@markii/core`'s
 * `parse`), unchanged by this function or by `nodeToHast`.
 *
 * This is a pure, one-shot render of a static node — not a cell, not
 * unrender-to-edit, not a live-preview surface, and it carries no
 * memoization or state of its own; a caller that wants any of that builds it
 * on top, out of scope for this function.
 */
export function renderMarkNode(
  node: MarkNode,
  registry: Registry,
  store?: ValueStore,
  vault?: VaultStore,
): ReactElement {
  try {
    const hastTree = nodeToHast(node);
    return hastToReactTree(hastTree, registry, store, vault);
  } catch (error) {
    return renderFailureFallback(error);
  }
}
