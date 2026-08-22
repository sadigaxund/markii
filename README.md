# Markii

[![CI](https://github.com/sadigaxund/markii/actions/workflows/ci.yml/badge.svg)](https://github.com/sadigaxund/markii/actions/workflows/ci.yml)

Markii is markdown that renders your own components. A `.mk.md` file is plain
CommonMark plus one small directive syntax, so it opens as readable markdown
in any editor, and opens as a living document, with callouts, tabs, charts,
and sandboxed scripts feeding them live data, in anything that speaks Markii.
(Markii rhymes with marquee.)

````markdown
:::callout{type=warning title="Heads up"}
This ships **Tuesday**.
:::

```lua {name=repo}
local r = net.fetch_json("https://api.github.com/repos/facebook/react")
return { stars = r.stargazers_count }
```

facebook/react has :value[repo.stars] stars.
````

Delete every directive and script and a coherent note remains. That is the
line Markii holds: components and scripts feed the document; they never become
the document. Unknown components degrade to a labeled box, scripts never run
on open, and nothing in a note can break the page.

## Getting started

Try the playground at https://sadigaxund.github.io/markii/: source on the
left, rendered document on the right, a Run button for the scripts.

To render Markii documents in your own React app:

```
npm install @markii/core @markii/react
```

```tsx
import { renderMark } from '@markii/react';
import { defaultRegistry } from '@markii/react/components';

const view = renderMark(source, defaultRegistry);
```

### Platforms

| Platform                          | Status                                    |
| --------------------------------- | ----------------------------------------- |
| React (`@markii/react`)           | available                                 |
| VS Code extension                 | planned (next milestone)                  |
| Other toolkits (Vue, terminal, …) | the format is renderer-neutral; see below |

## Components

Every Markii app ships the standard set: callout, card, badge, details,
figure, tabs, kbd, rating, and the data-bound stat, progress, and chart.
They cover everyday notes, and they are defaults, not the ceiling.

When you outgrow them, components travel as a pack, and the journey is the
same whether you write one or install someone else's:

1. A pack is a folder: a small manifest naming the pack and the engine its
   components are written for (React, for example; any supported renderer
   engine works the same way), plus the component sources.
2. Each component is an ordinary component in that engine, nothing special
   to learn: it receives the directive's attributes and its inner markdown,
   already rendered.
3. Build it once with the pack's one build command. Installing a ready-made
   pack skips this step entirely, because published packs ship prebuilt.
4. Install the pack into whichever Markii app you use, by pointing the app at
   the pack folder.
5. Type the prefixed name in a note: `:::ana-timeline`. On a machine
   without the pack, the same note shows a labeled fallback and stays
   readable.

Packs are designed but not shipped yet; the contract lives in
[docs/packs.md](docs/packs.md).

## Integrating and extending

Markii is a format first and a library second. The definition is the spec plus
a language-agnostic conformance corpus, so a renderer in any language can
claim support by passing the same fixtures this repo tests against.

- Registering your own components, layout, scripting, bundles: start at
  [docs/format.md](docs/format.md) and the [docs index](docs/README.md).
- Embedding the libraries or writing a new renderer:
  [docs/integration.md](docs/integration.md).
- Sharing components as packs (designed, upcoming):
  [docs/packs.md](docs/packs.md).
- The normative rules: [docs/spec.md](docs/spec.md).

## Development

```
npm install
npm test       # every workspace
npm run dev    # playground
```

The repo is an npm-workspaces monorepo: six `@markii/*` packages split along
the format's seams, a conformance corpus, and a thin playground. Read
[AGENTS.md](AGENTS.md) and the docs before changing parser or renderer
behavior.

## License and contributing

MIT. Issues and pull requests are welcome; changes to parser-visible
behavior need a conformance fixture, and the docs pages are the source of
truth for what the format is.
