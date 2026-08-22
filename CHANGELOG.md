# Changelog

All notable changes to Mark and the `@markii/*` packages are recorded here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-08-22

### Fixed

- **Fetch and cache results are plain Lua data (`@markii/lua`)**:
  `net.fetch_json`, `net.post`, and `net.patch` used to hand scripts a
  wasmoon proxy object (userdata) instead of the JSON-shaped Lua data the
  API documents, and `cache.get` did the same for a stored value on a
  cache hit. Three script-facing bugs followed (issue #6): returning a
  nested piece of a fetch result failed with a marshal error, `type()`,
  `#`, and `pairs` behaved inconsistently on results, and reading a JSON
  `null` field raised an error instead of yielding `nil`. Responses and
  cache hits are now decoded inside the sandbox into genuine Lua tables,
  with depth/node caps enforced host-side before decoding. The cache
  write path is also bounded now: a value being stored passes through the
  same capped, cycle-safe walk as a script's return value, so cyclic or
  oversized values fail cleanly instead of reaching storage, and a
  host-stored value that exceeds the caps is denied on the hit path the
  same way an oversized fetch response is. A JSON `null` decodes by one
  rule: absent as an object field, `false` in an array position (arrays
  stay dense). The change was adversarially verified; the review closed
  four hardening gaps before merge, including an array-marker spoof via
  remote JSON and call-time rebinding of the decoder's primitives.
  Behavior notes for consumers: the depth/node caps now bound fetched
  responses (previously only the byte cap effectively applied, since
  structured results could not be marshaled at all), and a cached value
  with mixed or sparse table keys now fails the marshal walk explicitly
  instead of being converted best-effort. New public API: the
  `CapabilityConfig.marshalLimits` field, plus `checkJsonWithinLimits`
  and `FETCH_DECODE_ERROR_TAG` exports.

### Added

- **Row alignment cascade (`@markii/react`)**: `align` on `:::row` now sets
  the text alignment inside every cell, instead of the (meaningless) block
  placement of the full-width row itself. An alignment wrapper written
  inside a cell still wins, so one cell can opt back out. Invalid values
  degrade silently, as everywhere in layout. New conformance fixture
  `27-row-align-left-wrapper`.
- **`:::left` layout wrapper (`@markii/react`, `@markii/stdlib`)**: a sixth
  wrapper, symmetric with `:::right`. It matches the default on its own and
  exists to override an inherited alignment, such as one cell of a
  `:::row{align=center}`. Contract added to `STANDARD_COMPONENTS`.

## [0.3.0] - 2026-08-18

### Added

- **Frontmatter tolerance (`@markii/core`)**: `parse` and `toHast` now run
  `remark-frontmatter`, so a leading `---` YAML block parses as a `yaml`
  node — exposed in the AST, dropped from the rendered output — instead of
  being read as a thematic break plus stray text. Everywhere else `---` keeps
  its ordinary CommonMark meaning: mid-document it is still a thematic break,
  an unclosed opening fence still degrades to ordinary markdown, and a
  frontmatter-shaped block that is not the document's first construct is not
  frontmatter. New exports `extractFrontmatter` (`{ raw, uses? }`, from
  source text or an already-parsed tree) and `extractFrontmatterUses` read
  the one format-defined key. The reader is hand-rolled and there is NO YAML
  dependency: it understands `uses: [a, b]` and the block-list form, quoting
  and whitespace tolerated, and returns `undefined` — never a throw, never a
  partial list — for anything else. New conformance fixtures
  `19-frontmatter`, `20-frontmatter-block-list`, `21-frontmatter-unclosed`,
  `22-frontmatter-not-at-start`, `23-thematic-break-mid-document`.
- **Registry aliases (`@markii/react`)**: a registry can now give an existing
  component a second name with preset attributes — `warn` standing for
  `callout{type=warning}` — via a new optional second argument to
  `createRegistry`, or the exported `REGISTRY_ALIASES` symbol on a
  hand-built registry. Resolution happens at lookup time, one hop only (an
  alias pointing at another alias lands on the unknown-directive fallback,
  never chains); a real registered component always beats an alias of the
  same name; author-written attributes always beat the alias's presets; a
  preset `width`/`align` goes through the same reserved-attribute
  interception as an author-written one; and an alias to an unregistered
  target renders the standard fallback for the TARGET name. `mergeRegistries`
  merges alias tables per name with the same last-wins semantics it gives
  components. Aliases are registry/app-level configuration and are never
  definable inside a note. Also exported: `registryAliases`,
  `resolveDirectiveAlias`, and the `RegistryAlias`/`RegistryAliases`/
  `ResolvedDirective` types.
- **Layout wrapper containers (`@markii/react`, `@markii/stdlib`)**:
  `:::center`, `:::right`, `:::wide`, `:::narrow`, `:::full` — five registry
  aliases of one wrapper component that carry DESIGN.md §4's closed layout
  presets to plain markdown a directive attribute cannot reach (a GFM table
  or a bare image has no `{...}`). Attribute-free by design; nesting a width
  wrapper inside an alignment wrapper composes. `@markii/react/components`
  exports `createLayoutWrapper`, `LAYOUT_WRAPPER_PRESETS`, and
  `LayoutWrapperPreset`; `defaultRegistry` gains the five names, and
  `@markii/stdlib`'s `STANDARD_COMPONENTS` gains their contracts. New
  conformance fixture `18-layout-wrappers`.
- **`:::cell` grouping container (`@markii/react`, `@markii/stdlib`)**: a
  transparent container whose only job is making several blocks count as ONE
  cell of `:::row`. A row's cells are its direct block children, so two
  blocks are two cells; a `cell` around them makes them one. It also settles
  a case that was otherwise impossible: markdown merges two adjacent lists
  into a single list, so two task lists could never be two row cells — one
  `cell` around each separates them. Attribute-free, no look of its own
  (a plain `<div class="mk-cell">`, no border, background, padding, or outer
  margin — only a `doc.css` rule restoring rhythm between its own children),
  and inert outside a row. `@markii/react/components` exports `Cell`,
  `defaultRegistry` gains the `cell` name, and `@markii/stdlib`'s
  `STANDARD_COMPONENTS` gains its contract. No conformance fixture: at parse
  level `:::cell` is an ordinary container directive with no new AST shape.
- **Failure presentation parity (`@markii/react`)**: `MarkComponentProps`
  gains optional `dataError` and `dataFailureKind`, so `stat`/`progress`/
  `chart` present a failed `data=` binding exactly the way `:value[...]`
  already did — a `title` tooltip plus a modifier class hook
  (`mk-stat--tier-blocked`, `mk-chart--stale`, ...), never body text. Both
  props are supplied only for a directive that had a `data=` attribute, and
  `dataFailureKind` only for a genuine `error` resolution.

### Fixed

- **Directive form/kind mismatch no longer emits invalid HTML
  (`@markii/react`)**: a block component written as an inline directive —
  `:center[x]`, `:row[x]`, `:callout[x]` — used to render its block element
  inside the paragraph the directive was written in, i.e. a `<div>` inside a
  `<p>`, which every HTML parser restructures (the paragraph is closed and
  reopened), so the resulting DOM stopped matching the tree the renderer
  built. Such a directive now degrades to the unknown-directive fallback
  instead of rendering the component, and the fallback's ELEMENT follows the
  directive's form: an inline directive gets the `<span>`-based marker, a
  block directive the existing box. The label says which way round the
  mismatch is — "block component `center` written inline" — and the fallback
  carries an extra `mk-unknown--mismatch` class hook; the inner content is
  still shown, and nothing throws. Kind is read from the registry entry's own
  `inline` flag and nowhere else, so a component registered without one
  behaves exactly as before — degradation happens only where the mismatch is
  knowable — and a hostile entry whose `inline` getter throws fails permissive
  rather than escaping the render. The reverse direction (an inline component
  written as a leaf or container, `::kbd{}`, `:::badge ... :::`) deliberately
  stays permissive: phrasing content in block flow is parsed exactly as
  written and round-trips, so degrading it would cost the author their content
  for no correctness gain. `@markii/react/components` exports the new
  `DirectiveFallbackReason` type, and `UnknownDirectiveProps` gains an
  optional `reason`.
- **Never-throw against a hostile host store (`@markii/react`)**:
  `renderMark`/`renderMarkNode` only guarded parse and hast conversion, while
  a `data=`/`:value[...]` binding is resolved later, during React's render
  phase — so a host-supplied `ValueStore`/`VaultStore` whose `get()` threw,
  an entry with a throwing getter, or a stored value that was a revoked or
  trap-throwing `Proxy` hit during the dotted-path walk escaped the entry
  point's never-throw guarantee. The resolution layer (`resolveStorePath`/
  `resolveScopedPath`) now guards every host-store interaction; any such
  fault degrades to the ordinary `missing` resolution — the `{name}` marker
  for `:value[...]`, the quiet empty state for a data-bound component — with
  the thrown message carried in the existing `error`/tooltip channel and no
  `failureKind` invented. An off-contract `status` on a stored entry now
  degrades to `missing`, and a non-string `error`/`failureKind` is dropped
  rather than passed on to a `title=` attribute or a class lookup.
  `:value[...]` also survives a stored value whose `JSON.stringify` and
  `String()` both throw, rendering empty instead.
- **Never-throw in the reference data-bound components (`@markii/react`)**: a
  BARE (non-dotted) `data=` name performs no path walk, so the hostile value
  reached `stat`/`progress`/`chart` untouched and threw inside their own
  field reads (`Array.isArray`, property access, array iteration). All three
  now read a bound value through a shared `safeRead` guard: an unreadable
  binding degrades to the component's ordinary quiet empty state (`—`, a
  `0%` bar, `no data`), with the thrown message reaching only the tooltip and
  no `failureKind` invented. `chart` still plots a static `values=` series
  when the bound one is unreadable. A THIRD-PARTY registry component that
  throws while reading its own `data` prop is unchanged — that remains the
  embedding app's to guard; the standard set exemplifies the contract rather
  than relying on the exemption.

## [0.2.0] - 2026-08-17

Layout, cross-note data sharing, a block-level render primitive, and a
hardened scripting failure model. This release adds public API and changes
some existing behavior, so it is a minor version, not a patch.

### Added

- **Layout presets (`@markii/react`, `@markii/stdlib`)**: `width` and `align`
  as reserved directive attributes mapped to a closed set of theme classes,
  and a `:::row{cols=2|3|4}` container for side-by-side dashboards. Invalid
  values degrade silently; plain viewers stack.
- **Vault-published values (`@markii/runtime`, `@markii/core`,
  `@markii/react`)**: the bulletin board — a script fence with the bare
  `publish` attribute publishes its named value to a vault-level store; any
  note reads it with an `@`-prefixed name (`data=@gh.stars`). A read-only
  `VaultStore` plus a capability-style `VaultWriter` (possessing the writer is
  the publish grant), one writer per name.
- **Block-level render primitive (`@markii/core`, `@markii/react`)**:
  `nodeToHast` and `renderMarkNode` render a single parsed node with the same
  contract as the whole-document path — a pure render function, not an editor.
- **Failure taxonomy (`@markii/runtime`, `@markii/lua`)**: a closed
  `FailureKind` (script-error, capability-denied, tier-blocked, limit) derived
  from non-spoofable error identity, replacing message-string classification.
- **Grant-closure key (`@markii/runtime`)**: `computeGrantKey` hashes a note's
  full executable closure (scripts, `src` files, vault-library and pack
  modules) so a permission grant is re-prompted when any of that code changes.
- `renderMark` gained an optional fourth `vault` argument (existing three-arg
  calls are unchanged); `@markii/core` exports `isBareAttribute`.

### Changed

- **Chart** no longer accepts pixel `width`/`height` attributes — components
  size to their container and layout presets are the sizing story.
- Boolean fence-meta attributes (`publish`, `open`) are **bare-only** and fail
  closed: `open=false` no longer opens a script marker.
- Script names must match `[A-Za-z_][A-Za-z0-9_-]*`; a fence whose name has a
  dot (or other invalid character) is display-only, not runnable.
- `messageForFailure` was removed in favor of the structured `FailureKind`.

### Fixed

- **Sandbox (`@markii/lua`)**: the marshal walk's node/depth/key caps are now
  immune to a script rebinding `error`/`type`/`pairs`/`math.floor`; embedded
  NUL bytes in a returned string are rejected rather than silently truncated;
  `runScript` never raw-throws, even on an unexpected internal exception.
- **Render primitive (`@markii/core`)**: caller-supplied `data.hName`/
  `hProperties`/`hChildren` are stripped from an input node, closing an
  injection path unique to the AST-accepting entry point.

### Security

- A full evidence-backed re-audit of the `@markii/lua` sandbox
  (`docs/lua-sandbox-audit.md`); the two findings above were its result.

## [0.1.0] - 2026-08-17

First public release.

Mark is a markdown format that renders your own components inline. It is
CommonMark and GitHub-Flavored Markdown plus a small directive syntax, with
optional sandboxed Lua scripting that feeds live data into the page. A `.mk.md`
file stays readable as plain markdown in any editor, and a Mark-aware renderer
adds the components on top. The product is the format and its reference library,
not an application.

This release ships the format, its conformance corpus, and a reference
implementation split across six packages.

### Added

- **Parser (`@markii/core`)**: CommonMark and GFM to an AST, generic directive
  tagging, and a URL-sanitizing tree for renderers. Zero React dependency.
- **Component contracts (`@markii/stdlib`)**: the neutral schema every renderer
  targets, so the same component names mean the same thing across toolkits.
- **Reference renderer (`@markii/react`)**: a registry that maps a directive
  name to a component, its attributes to props, and its inner markdown to
  children, with a labeled fallback box for unknown names so a page never
  breaks. Twelve standard components ship with it: callout, card, badge,
  details, figure, tabs and its tab child, kbd, rating, and the data-bound stat,
  progress, and chart.
- **Value store and run orchestrator (`@markii/runtime`)**: named script
  results, a pure read path, and a trigger-to-capability gate that keeps auto
  and scheduled runs read-only.
- **Lua sandbox (`@markii/lua`)**: Lua 5.4 in WebAssembly, started in an empty
  environment with host-injected capabilities and limits on instructions, wall
  clock, memory, and fetch size.
- **Bundle handling (`@markii/bundle`)**: the `.mkbundle` container for a
  document with its scripts, assets, and cache, with a path jail for
  bundle-relative access.
- **Conformance corpus**: `.mk.md` inputs paired with their expected AST as
  JSON, so a renderer written in any language can verify against the same
  fixtures.
- **Documentation and demo**: the design spec (`DESIGN.md`), a README, and a
  hosted playground.

[0.2.0]: https://github.com/sadigaxund/markii/releases/tag/v0.2.0
[0.1.0]: https://github.com/sadigaxund/markii/releases/tag/v0.1.0
