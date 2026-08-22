# Markii (.mk.md)

An extensible markdown format: CommonMark + generic directives that render the
author's own components. **The product is the file format and its reference
library — not an app.** Read the `docs/` pages before writing any code —
`docs/spec.md` is the normative core and, with the topic pages beside it, the
source of truth for syntax, architecture, and scope.

This file is the single project-instruction file for all agents and tools.
`CLAUDE.md` is a pointer stub — never add content there.

Naming policy (user-set 2026-08-22): the product is **Markii** — one name
everywhere (titles, prose, "a Markii document"); pronounced like marquee.
The earlier Mark / "Mark II in titles" split is retired. Files are
`.mk.md`, bundles are `.mkz` (legacy `.mkbundle` still recognized).
Spec versioning is plain semver; the trailing "ii" is not a version.

## Product principles (binding)

Judge every feature and change against three concerns, in this order of
who they serve — with the third acting as the overriding scope test:

1. **Casual users first.** Most users have single `.mk.md` files, do
   surface-level scripting at most, and mainly enjoy the added components.
   Anything that makes the simple case harder is wrong.
2. **Power users are served through bundles and shared code.** Complex
   workflows live in `.mkz` bundles; shared Lua is maintained once (vault
   library or pack) and `require`d everywhere; dashboard-like monitoring
   notes are a first-class use case.
3. **Cleanliness (the overriding rule).** The file system and the rendered
   note stay clean. Technicality is abstracted into raw source or into the
   host app: the rendered page shows quiet markers (tooltips, collapsed
   script markers, empty/stale states), never error dumps or machinery.
   Scope test for any change: does it keep both the file tree and the
   rendered page clean while still serving the power-user workflow?

## Repo layout (npm workspaces)

```
docs/                the spec + documentation — source of truth. spec.md is the
                     normative core; format/scripting/bundles/security/
                     integration/packs.md carry the full material per topic
conformance/         language-agnostic corpus: *.mk.md inputs + expected-AST *.json
packages/markii-core    framework-agnostic reference impl — ZERO React dependency:
  src/parse.ts       text → mdast AST (unified + remark-parse + remark-directive)
  src/to-hast.ts     mdast → hast: directive tagging (data.hName) + URL sanitizer
  src/corpus.ts      conformance-corpus runner (load fixtures, strip positions)
packages/platforms/markii-react   the reference L1 renderer, a platform adapter
                        (one consumer of @markii/core among possible many):
  src/registry.ts    Registry types + createRegistry/mergeRegistries
  src/render.tsx     hast + registry → React tree (unknown-directive fallback;
                     folds {name=…} script blocks into a collapsed marker)
  src/components/    the @markii/stdlib standard set (callout, card, badge,
                     details, figure, tabs/tab, kbd, rating; data-bound
                     dashboard: stat, progress, chart; row + cell; layout wrappers
                     center/right/wide/narrow/full via createLayoutWrapper;
                     failure-presentation.ts — the ONE home of failure wording)
  src/doc.css        document rhythm + component internals
packages/markii-runtime host-side scripting glue (docs/scripting.md) — neutral, no React,
                        no wasmoon; stays runtime-agnostic (executor injected):
  src/store.ts       ValueStore + createValueStore (null-proto, hasOwn-guarded)
  src/run.ts         runDocumentScripts + trigger→tier gate (auto/scheduled=read-only)
packages/markii-stdlib  standard component contracts (docs/integration.md) — neutral,
                        zero deps, no React; the seam every renderer implements against:
  src/contracts.ts   ComponentKind/AttributeSchema/ComponentContract types,
                     STANDARD_COMPONENTS (callout/kbd/rating), getContract()
packages/markii-bundle  .mkz bundle handling (docs/bundles.md, L2) — no React, no parsing:
  src/manifest.ts    manifest.json types + hand-rolled validation (no schema deps)
  src/paths.ts       path-jail: bundle-relative path normalization/rejection
  src/zip.ts         zip form via fflate (browser-safe main entry)
  src/fs.ts          directory form via node:fs (Node-only "./fs" subpath export)
  src/script-view.ts capability-restricted view for future script runtime (§11)
packages/markii-lua     Lua sandbox runtime (docs/security.md, L3) — no React, no parsing:
  src/globals.ts     empty-env whitelist: curated string/table/math only
  src/capabilities.ts net/cache/bundle tables; two-tier (manual vs auto) gating
  src/limits.ts      instruction-count hook, wall-clock/memory/fetch-size caps
  src/require.ts     sandboxed require: bundle scripts/ + pack modules, pure Lua
  src/marshal.ts     Lua↔JS value conversion (serializable-only, depth/size caps)
  src/sandbox.ts     runScript(): assemble env + limits + caps, run, marshal result
  src/executor.ts    createLuaExecutor(): adapts runScript to @markii/runtime's ScriptExecutor
apps/playground      thin Vite dev harness to view .mk.md files. NOT the product.
apps/vscode          the "Markii" VS Code extension (v1: preview only) — an
                     app/consumer of @markii/react, never a renderer:
  src/extension.ts   activation + the markii.openPreview command
  src/preview-panel.ts  the single webview panel; with extension.ts the ONLY
                     files allowed to import `vscode` (vitest cannot resolve
                     it, so all testable logic lives in plain modules)
  src/protocol.ts    host<->webview message contract + hostile-shape guards
  src/resource-roots.ts  localResourceRoots coverage logic (vscode-free);
                     src/webview/document-images.ts resolves relative img
                     srcs against the document's baseUri (img only, no <base>)
  src/webview-html.ts  the CSP shell: nonce'd script, no remote hosts
  src/webview/       the bundled React preview (renderMark + defaultRegistry)
                     and theme.css, mapping --vscode-* colors onto doc.css
                     without forking it (theme-coverage.test.ts guards drift)
  syntaxes/          TextMate injection grammar for the three directive forms
  esbuild.config.mjs two bundles: extension host (node/cjs, vscode external)
                     and webview (browser/iife); @markii/* aliased to src/
```

Platform renderers live under `packages/platforms/*` (a workspace root alongside
`packages/*` and `apps/*`); the neutral core packages stay directly under
`packages/*`. Future non-React renderers go under `packages/platforms/` too.
Consumer applications (the playground, the VS Code extension) go under
`apps/*` — they consume platform renderers, they are not renderers themselves.

Import rule: @markii/core must never import React or anything from @markii/react;
@markii/react imports @markii/core and @markii/stdlib (the neutral contracts it
implements); the playground imports @markii/react. The conformance
corpus is plain data — no TypeScript in `conformance/`.

## Stack (fixed — do not add alternatives)

- TypeScript (strict), React 18, Vite, Vitest
- Parsing: `unified`, `remark-parse`, `remark-gfm` (tables/task-lists/
  strikethrough/autolinks), `remark-directive`, `remark-frontmatter`,
  `remark-rehype`, `hast-util-to-jsx-runtime`, `mdast-util-directive`,
  `unist-util-visit`. No YAML library — the `uses:` accessor is hand-rolled
  for the simple list forms only, same philosophy as manifest validation.
- Playground editor: CodeMirror 6 (playground only)
- Bundles: `fflate` (zip form; @markii/bundle only)
- Lua sandbox: `wasmoon` (Lua 5.4 in WASM; @markii/lua only)
- Package manager: npm (workspaces). No pnpm/yarn/bun.
- VS Code extension only (`apps/vscode`, orchestrator-approved 2026-08-17;
  tsx added 2026-08-22): `@types/vscode`, `@vscode/vsce`, `esbuild`
  (extension bundling), `tsx` (dev-only: spawns the TypeScript worker
  under Vitest). These never enter `packages/*`.

## Architecture rules (from the spec — violations are bugs)

1. The parser is component-agnostic: it emits generic directive nodes and must
   never import from the registry or components.
2. The renderer is registry-driven: directive name → component, attributes →
   props, inner markdown → children (pre-rendered).
3. Unknown directives NEVER throw: render the fallback box (dashed border,
   "unknown component `name`", inner content as plain markdown).
4. Components own their insides only: no outer margins on any component; the
   document stylesheet owns vertical rhythm (`.doc > * + * { margin-block-start: … }`).
5. Directive syntax stays non-Turing-complete: no expressions, conditionals, or
   loops in attributes.

## Coding standards

- TS strict mode; no `any` (use `unknown` + narrowing); no `@ts-ignore`.
- Small focused modules; named exports; no default exports except React lazy needs.
- Tests: Vitest, colocated `*.test.ts(x)`; every parser behavior gets a
  conformance fixture, not just inline strings.
- Formatting: Prettier defaults. Lint: ESLint flat config, typescript-eslint
  recommended. Both must pass.
- Dependencies: only what's listed under Stack. Adding anything else requires
  explicit approval from the orchestrator.
- Components are SELF-BUILT: no third-party UI / component / charting library
  (no MUI, Chakra, Recharts, etc.) — the standard set is hand-rolled
  (the dashboard chart is dependency-free SVG, deliberately) so a component
  can never break because an upstream package did. This is a hard rule for
  the reference set (@markii/stdlib, @markii/react) and the recommended
  posture generally. There is no "port an existing external component
  library" path — external component-library dependencies are out of scope.

## Documentation style (user-set, binding)

Two kinds of documents, two different jobs. These rules govern every edit
to `README.md` and `docs/` — violating them is rework, not taste.

**README = the front door. It links, it does not explain.** Keep it well
under 150 lines, in exactly this shape:

1. Tagline + hook: what this is and why it exists, with one tiny example —
   enough to stop a reader from leaving.
2. Getting started: install, try-it, and platform support shown as a
   showcase table (available vs planned).
3. Integrate & extend: a SHORT summary whose job is pointing into the
   `docs/` pages — never the material itself.
4. A compact footer: license, contributing.

Anything that can be referenced from `docs/` must not be expanded in the
README. Overpacking the README is the failure mode to guard against.

**`docs/` = documentation for humans who open it and read.** All heavy
technical material lives here, and it must read as prose someone follows,
not notes someone decodes:

- Each page has one audience (note-writer / power user / integrating
  developer) and a coherent, logical flow; `docs/spec.md` stays the short
  normative core, with rationale in the topic pages.
- Plain language. No jargon-dense sentences; never cram several facts into
  one sentence — split it.
- No long code inline or inside a paragraph. Code sits in short display
  blocks; if a sample grows, restructure the section instead.
- Professional documentation tone throughout. First-person diary phrasing
  ("What I did NOT test") never ships in docs/ — audit material is
  rewritten as verification status, keeping the evidence and the honesty,
  losing the diary voice.
- No em dashes in authored pages: docs/, both READMEs, and demo content.
  Rephrase with a colon, a comma, a parenthetical, or a new sentence. The
  user reads em dashes as generated-text slop; "house style" is not an
  exemption (that rationalization was tried and rejected 2026-08-18).
- Final pass on every authored page: apply the humanizer rules
  (https://raw.githubusercontent.com/blader/humanizer/refs/heads/main/SKILL.md)
  — strip inflated claims, filler, forced parallelism, decorative bolding,
  and chatbot artifacts. Reference it; do not inline it.
- While re-authoring, collect gaps and misdesigns and REPORT them; never
  silently change a design decision as part of a rewrite.

## Maintenance map (what to update when something changes)

Cross-references rot silently. These pairings are mandatory and belong in the
same commit as the change that triggers them:

- **Parser-visible behavior** (anything an AST consumer can observe) → a
  conformance fixture in `conformance/` plus colocated tests. No exceptions.
- **Format semantics or a feature contract** → the `docs/` pages updated in
  the same commit: `docs/spec.md` for the normative rule, the topic page
  (format/scripting/bundles/…) for the explanation. Code and spec must never
  diverge.
- **Security-relevant finding or fix** (sandbox, sanitizer, capability gating,
  path jail) → the security documentation in `docs/` updated in the same
  commit: what was found, what changed, professional tone, evidence kept.
- **Public API of any `@markii/*` package** (export added/removed/changed,
  behavior change observable by consumers) → `CHANGELOG.md` entry; weigh the
  semver impact for the next release.
- **New workspace/package** → the repo-layout section of this file, the root
  `package.json` `build:dist` chain, and the release workflow's package list
  under `.github/`. A non-published _app_ workspace (playground, vscode)
  joins the repo layout only; `build:dist` and the release workflow list
  npm packages.
- **New stdlib component** → contract in `@markii/stdlib`, component + tests
  in `@markii/react`, `doc.css` for its internals (never outer margins), and
  the component list in this file's repo layout.
- **Rename/move of any top-level doc** → fix every cross-reference in the
  same commit: `README.md`, this file, `TODO.md`, `docs/`, and source
  comments (grep for the old name).
- **Work state** → `TODO.md` is the authoritative queue but is LOCAL-ONLY
  (gitignored since 2026-08-18, pending items only); the public roadmap is
  GitHub issues. Decisions with lasting effect go in the spec or an issue,
  never only in chat history or the local queue.

## Session rules for agents

- Subagents must NOT run any `git` command (no commit, no branch, no init).
  The orchestrator commits. Report what you changed instead.
- Do not create files outside your assigned scope; if two agents run in
  parallel they own disjoint directories.
- Verify before reporting done: `npm test`, `npm run build`, `npm run lint`
  must all pass from the repo root. Report actual command output, not claims.
- Do not edit the `docs/` pages or AGENTS.md; propose changes in your report
  instead. (The orchestrator owns spec and docs edits.)

## Commands (repo root)

- `npm test` — run all workspace tests
- `npm run build` — build all workspaces
- `npm run lint` — lint all workspaces
- `npm run dev` — start the playground
