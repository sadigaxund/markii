# Integrating Markii

This page is for developers: embedding the reference libraries in an
application, writing a renderer of your own, and what a host application is
responsible for. Users never read this; they install an app.

## The standard is the spec plus the corpus

Markii follows the CommonMark model of standardization: the definition is the
written spec together with a corpus of example documents that every
implementation must reproduce. The reference TypeScript libraries are one
implementation, not the standard itself.

The corpus lives in `conformance/` as plain data: each fixture pairs a
`.mk.md` input with its expected syntax tree as JSON, plus behavioral cases
such as "directives inside code fences must not parse" and "an unclosed
container must not throw". A Rust, Swift, or Python implementation tests
against the same files. Passing the corpus is what "supports Markii" means.

Markii inherits its hard parts rather than inventing them. The syntax is
CommonMark plus GFM plus the generic directive proposal, and the syntax-tree
node shapes come from the existing `mdast` directive utilities. Parsers for
all of this already exist in several ecosystems.

## Conformance levels

Levels keep a minimal viewer cheap to build, and honest about what it does:

| Level | Means | Package tracking it |
|---|---|---|
| L0 | parses documents to the standard tree | `@markii/core` |
| L1 | renders with registry, fallback, and purity rules | `@markii/react`, contracts in `@markii/stdlib` |
| L2 | opens `.mkz` bundles | `@markii/bundle` |
| L3 | runs scripts under the capability model | `@markii/runtime` + `@markii/lua` |

A read-only viewer can ship at L1 and say so. The normative requirements for
each level are in [spec.md](spec.md).

## What a conforming renderer must do

The renderer contract never mentions React, or any framework. A conforming
renderer resolves directive names through a registry, passes attributes as
string key-value pairs, renders directive children as markdown, shows a
visible fallback for unregistered names without failing the document, and
is side-effect-free on open: reading never executes scripts. A terminal
viewer, a Vue application, and a static HTML exporter can all conform.

## Embedding the reference libraries

Only developers embedding Markii take npm dependencies; end users install an
application. The split is:

- `@markii/core`: text to syntax tree, directive tagging, URL sanitizing,
  and the corpus runner. Zero React.
- `@markii/stdlib`: the neutral component contracts (names, kinds,
  attribute schemas) every renderer implements against. Zero dependencies.
- `@markii/react`: the reference renderer, holding the registry,
  `renderMark`, and the standard component set. One consumer of core among possible many; it lives
  under `packages/platforms/` precisely so a sibling renderer for another
  toolkit has a place to sit.
- `@markii/runtime`: the value store, run orchestration, vault store, and
  grant-key computation. Framework-free and runtime-agnostic; the script
  executor is injected.
- `@markii/bundle`: bundle reading and writing in both forms, manifest
  validation, and the path jail.
- `@markii/lua`: the sandboxed Lua executor that plugs into the runtime.

A minimal React embedding is a registry plus one call:

```tsx
import { renderMark } from '@markii/react';
import { defaultRegistry } from '@markii/react/components';

const view = renderMark(source, defaultRegistry);
```

The standard component set lives at the `@markii/react/components` subpath,
not the main entry, so an application that brings its own registry never
pulls the standard components into its bundle. Adding your own component is
one registry entry, built with `createRegistry` or merged over the default
set with `mergeRegistries`; its attributes arrive as props and its inner
markdown arrives pre-rendered as children. `renderMark` also accepts an
optional value store and vault store for documents that use scripting, and
`renderMarkNode` renders a single block from a parsed document under the
same contract, for hosts that need block-level granularity.

## Host responsibilities for scripting (L3)

The libraries deliberately stop at the seam where application policy begins.
An application that enables scripting owns the following, in rough order of
importance:

1. **A terminatable isolate.** Run scripts in a Web Worker or worker thread
   with an external wall-clock watchdog that terminates it on overrun. This
   is normative, and auto-run is unsound without it; see
   [security.md](security.md).
2. **The grant store and prompts.** Persist grants keyed by
   `computeGrantKey`'s executable-closure hash, re-prompt when the key
   changes, and word network prompts as "can send data to `<host>`".
   Re-validate stored hosts when you read them back, so a record written by
   an older or buggy version cannot reintroduce a host your current checks
   would reject.
3. **A bounded network capability.** The `net` implementation is the real
   allowlist boundary, so it enforces it: resolve redirects yourself and
   check every hop's host before requesting it, and bound each response to
   the fetch-size cap rather than buffering a whole body. A request whose
   host is built dynamically, and so cannot be named in advance, is denied;
   a prompt offered for that case must not imply the request will be
   allowed.
4. **Trigger discipline.** Route manual, auto, and scheduled runs through
   the runtime's trigger parameter so the tier gate applies; schedules live
   in the app, never in scripts.
5. **Value persistence.** Keep last-run values in app storage keyed by note
   identity, so plain files reopen with data while the vault directory stays
   untouched; write a bundle's `.cache/` only for bundles.
6. **The vault stores.** Enforce one writer per published name, and back the
   `@`-prefixed reads with your vault store implementation.
7. **The require mappings.** Map vault-library namespaces to folders, and
   resolve pack modules, keeping the reserved bundle segments
   (`scripts`, `assets`, `.cache`) bundle-local.

## Editor support

Editor tooling is application territory. A directive-aware language server
was considered and deliberately deferred; syntax highlighting for directives
and fence-meta plus a rendered preview cover most of the value, and that is
the shape of the planned VS Code extension: a webview preview embedding the
reference renderer, plus a grammar for highlighting.

## Where frameworks live

The format is framework-free, but component implementations are bound to a
renderer: a React pack renders only in React hosts. A pack therefore
declares its target engine, and a host that cannot run that engine shows the
standard unknown-component fallback, keeping the note readable everywhere.
Frameworks live in applications, never in notes: a `.mk.md` file is created
empty like any text file, and a bundle contains only content. No note or
bundle ever carries a runtime.
