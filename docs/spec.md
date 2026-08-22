# Mark specification: the normative core

This page collects the rules an implementation must follow. The surrounding
pages explain the same material for humans, with rationale and examples;
when wording differs, this page and the conformance corpus win. Key words
MUST, SHOULD, and MAY are used in their usual normative sense.

The spec is versioned with plain semver and is currently pre-1.0. The
format's name, Mark (branded Mark II in titles), carries no version
information. A bundle records the
spec version it targets in its manifest's required `mark` field.

## 1. Document syntax

A Mark document is UTF-8 text: CommonMark, plus GFM tables, task lists,
strikethrough, and autolinks, plus the three generic directive forms:

- inline `:name[label]{attrs}`
- leaf block `::name{attrs}`
- container `:::name{attrs} … :::`

Syntax-tree node shapes follow `mdast-util-directive`: textDirective,
leafDirective, and containerDirective, each with `name`, string-valued
`attributes`, and `children`.

Raw HTML MUST NOT be rendered; an implementation drops `html` nodes.
Directives MUST NOT parse inside code fences. Malformed or unclosed
directive syntax MUST degrade to text, never to an error. A closing fence
closes the innermost open container; a container left open MUST be closed
implicitly when its enclosing container's fence or the end of input
arrives, never reported as an error. Optional YAML
frontmatter MAY open a document, delimited by `---` lines, and is
recognized only as the document's first construct. It MUST parse to a
distinct metadata node and MUST NOT be rendered. A `---` sequence anywhere
else keeps its ordinary CommonMark meaning, and an unterminated opening
fence MUST degrade to ordinary markdown, never to an error. Frontmatter's
one format-defined key is `uses`, a list of pack names, informative only.
An implementation MUST read the flow form (`uses: [a, b]`) and the
block-sequence form (`- name` lines); it MUST NOT fail on any other shape,
and treating an unreadable `uses` as absent is conforming. Reading
frontmatter MUST NOT require a YAML parser.

Directive names SHOULD be lowercase-kebab. A name MUST NOT contain `:`.
Namespaced names from packs join the namespace and name with `-` or `_`.
The first path segments `scripts`, `assets`, and `.cache` are reserved for
bundle structure and MUST NOT be pack or library namespaces; the same
reservation applies to component name prefixes.

## 2. Attributes

Attribute values are plain strings. The attribute language is not, and must
never become, Turing-complete: no expressions, no conditionals, no loops.

`width` and `align` are reserved attribute names on every directive. A
renderer intercepts them before the component sees its attributes, valid
value or not, and a component never receives them. On inline directives
they are stripped and have no effect.

## 3. Layout

Layout controls form a closed set. There is no freeform styling attribute
and no arbitrary values; an invalid value degrades to the default silently.

- `width`: `narrow | normal | wide | full`
- `align`: `left | center | right`; visible only when the block is narrower
  than the column
- wrapper containers `:::center`, `:::right`, `:::left`, `:::wide`,
  `:::narrow`, `:::full`: apply the corresponding preset to their contents,
  including plain markdown; the alignment wrappers also set text alignment
  in scope
- `:::row{cols=2|3|4}`: the one multi-cell container; equal-width cells,
  responsive wrap; invalid or absent `cols` degrades to auto-fit. On a row,
  `align` sets the text alignment inside every cell rather than placing the
  row; an alignment wrapper written inside a cell takes precedence over the
  row's value
- `:::cell`: groups several blocks into one `row` cell; attribute-free,
  carries no presentation of its own, and is inert outside a row

Components MUST NOT ship outer margins; the document stylesheet owns
vertical rhythm. Block components are normal flow elements, never floated,
never absolutely positioned. Text MUST NOT wrap around components.

## 4. Renderer requirements (L1)

A conforming renderer:

1. resolves directive names through a registry mapping name to component;
2. passes attributes as string key-value pairs and renders directive
   children as markdown;
3. renders unregistered names as a visible fallback containing the inner
   content as plain markdown, without failing the document;
4. never throws on any input, including hostile directive names such as
   prototype members, and including a misbehaving host value or vault
   store: a `get` that throws, a stored entry whose property access
   throws, or a stored value whose property access traps throw during a
   dotted-path walk MUST degrade to the ordinary missing resolution of
   requirement 6, never propagate out of the renderer. A renderer's own
   standard components MUST hold to this when reading a bound value; a
   third-party component's internal failure remains the embedding host's
   to contain;
5. is side-effect-free on open: rendering MUST NOT execute scripts, and
   value reads are pure lookups of last-known state;
6. presents a failed value binding as a quiet placeholder with the reason
   out of the text flow (such as a tooltip), never as body text;
7. MAY resolve directive names through registry-level aliases: an alias
   names one target and optional preset attributes. An alias MUST be
   resolved at lookup time and MUST NOT be followed more than one hop; a
   registered component MUST take precedence over an alias of the same
   name; attributes written in the document MUST take precedence over an
   alias's presets; presets that are reserved attributes MUST be
   intercepted exactly as author-written ones are; and an alias whose
   target is unregistered MUST render requirement 3's fallback under the
   target's name. Aliases are configuration of the registry or the
   application: a document MUST NOT be able to define them;
8. MUST NOT render a component in a directive form its registered kind
   contradicts, where doing so would produce invalid nesting: a component
   registered as a block, written as an inline directive, renders
   requirement 3's fallback instead of the component. A fallback's form
   MUST follow the directive's form rather than the component's kind: an
   inline directive falls back to an inline element, a block directive to
   a block one. A registration that carries no kind information renders
   unchanged, and the reverse direction (an inline component written as
   a leaf or container) MAY render.

The contract is framework-neutral; the spec's normative text does not
mention any UI framework.

## 5. Script blocks

Only a fenced code block whose info-string meta carries `name=` or `src=` is
runnable; every other code block is display-only. The fence meta grammar is
normative: the first `{...}` group in the info string holds
whitespace-separated attributes of the forms `key`, `key=bare`,
`key="quoted"`, `key='quoted'`; quoted values may contain braces.

Boolean fence-meta attributes (`publish`; the reference renderer's `open`)
are bare-only. Any written value, including `=true`, counts as absent.
Implementations MUST fail closed: an unrecognized spelling never enables
behavior.

A script name MUST match `[A-Za-z_][A-Za-z0-9_-]*`. A block with an invalid
name is display-only, not an error. Script blocks may appear anywhere
markdown may; all names land in one note-scoped value store.

## 6. Values

Scripts return values; they never mutate the document. `:value[name]`
renders a value inline; `data=name` binds one to a component. Both accept
dotted paths resolved with own-property access only. A missing or stale
value renders the consumer's empty or stale state.

A script fence with the bare `publish` attribute publishes its value to a
vault-level store after a successful run. Consumers read vault values with
an `@` prefix. One writer per published name; the application MUST reject a
second publisher. Reading a vault value is pure and requires no grant;
publishing requires a grant.

## 7. Execution and capabilities (L3)

Rendering is pure; running is an event with a trigger, and the trigger caps
capabilities:

| Trigger | Tier |
|---|---|
| manual | all granted capabilities |
| auto-run on open | read-only: GET, bundle/cache reads, cache writes |
| scheduled | read-only |

Capabilities are declared in the bundle manifest, granted by the user, and
injected as functions; the sandbox environment is otherwise empty. Network
grants are per-host. Grants are keyed by a hash of the note's full
executable closure and MUST be re-prompted when any of that code changes.
Resource limits (instructions, wall-clock, memory, fetch size) bound every
run.

A host MUST run scripts in a dedicated terminatable isolate with an
external wall-clock watchdog. Auto-run and scheduled execution MUST NOT be
offered without it. In-process limits are best-effort by design.

## 8. Bundles (L2)

A bundle is a directory, or a zip of that directory, containing
`manifest.json`, the document, and optionally `assets/`, `scripts/`, and
`.cache/`. The two forms are equivalent. `.cache/` is disposable;
deleting it MUST NOT lose authored content.

Scripts see only their own bundle. Paths are resolved inside the bundle
root; absolute paths, `..`, and symlink escapes are rejected. Writes are
limited to `.cache/` by default; a script MUST NOT be able to write the
document or the manifest.

Three persistence invariants hold regardless of file form: rendering never
executes; the host never writes authored files; caches are disposable.
Where a host persists last-run values is host policy.

## 9. Conformance

Levels: L0 parse, L1 render behavior, L2 bundles, L3 scripting with the
capability model. An implementation states the level it meets.

The corpus in `conformance/` is part of the definition: `.mk.md` inputs
paired with expected syntax trees as JSON, plus behavioral assertions. An
implementation at a level MUST reproduce the corpus results relevant to
that level. The corpus is plain data, usable from any language.

## 10. Non-goals

Fixed by design, not open for extension: no rendered raw HTML, no freeform
styling, no floats, no expressions in attributes, no self-modifying
documents, no timers in the sandbox, no package manager for scripts, no
per-file dependencies or scaffolding, and no programming-language ambitions
for the directive syntax.
