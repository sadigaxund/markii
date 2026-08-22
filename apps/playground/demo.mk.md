# Welcome to Markii

This page is a Markii document, and you are standing inside the editor. Change
anything in the left pane and the right pane re-renders as you type. Nothing
you do here can break the page, so poke at everything.

## Start with what you know

Everything markdown does still works: **bold**, links, lists, tables. Markii
adds one rule on top: a *directive* places a component in the document.

:::callout{type=info title="This box is a directive"}
Type `:::callout` on a line, write any markdown inside, close with `:::`.
Try changing `type=info` to `warning`.
:::

Small ones fit inside a sentence: press :kbd[Ctrl+Z] if you regret an edit,
and mark things :badge[beta]{variant=info} or :badge[stable]{variant=success}.

## The live part

This document fetches its own data. Rendering never runs code, so the
block below sits inert until you click **Run scripts** above the preview:

```lua {name=repo}
local repo = net.fetch_json("https://api.github.com/repos/facebook/react")
return {
  stars = repo.stargazers_count,
  forks = repo.forks_count,
  spark = {3, 5, 4, 8, 7, 10, 12},
}
```

Click Run, then look: facebook/react has :value[repo.stars] stars.

Before the click, that sentence shows a quiet `{repo.stars}` marker, and
every component below shows an empty state. That is the format's core
promise: a document is always readable, with or without its data.

## A dashboard from one value

The script returned one value with three fields, and dotted paths reach into
it. Rows lay components side by side; a `cell` groups blocks into one cell:

::::row{cols=2}
:::cell
::stat{data=repo.stars label="stars" trend=up}
::progress{data=repo.stars max=250000 label="stars toward 250k"}
:::

:::cell
::stat{data=repo.forks label="forks"}
::chart{data=repo.spark kind=line}
:::
::::

Notice the colons: the outer `::::row` uses four, the `:::cell` fences
inside use three. Bigger fence, bigger box.

## Layout without CSS

Plain markdown can be placed too. Wrap anything in `:::center`,
`:::right`, `:::narrow`, `:::wide`, or `:::full`:

:::center
| build  | status  |
| ------ | ------- |
| `main` | passing |
:::

That table is centered because of the wrapper, not because of anything in
the table. There is deliberately nothing else to learn here: no style
attributes, no pixel values.

## More to play with

Tabs hold alternative views of the same spot:

::::tabs
:::tab{label="Why Markii?"}
Notes deserve components without becoming code. A Markii file stays plain
readable markdown in every editor on earth.
:::
:::tab{label="Non-goals"}
No expressions, no conditionals, no loops. A note is not a program, and the
syntax is designed so it never can be.
:::
::::

Details fold long content away. Add the bare `open` attribute to start
one expanded:

:::details{title="Click to expand"}
A collapsible block, closed by default. How is the tour so far, by the way?
::rating{value=5 max=5}
:::

And a figure pairs an image with a markdown caption:

::::figure{src="https://raw.githubusercontent.com/sadigaxund/markii/refs/heads/main/apps/playground/public/nature.jpeg"}

**Figure 1.** The caption is markdown, so it can hold *emphasis* or links.
::::


## Now break something

Rename `callout` above to `callotu` and watch: the page does not crash. An
unknown name renders a labeled box with its content intact, which is what
lets a note travel to machines with different components installed:

:::timeline{src="repo.json"}
Nothing here registers `timeline`, so this shows the fallback with the
content preserved. Nothing is lost.
:::

Directive syntax inside a code fence stays literal, so examples are safe:

```
:::callout{type=info}
Not rendered, because it is inside a fence.
:::
```

## Where to go next

This playground is a demo, not the product. The format and its libraries
live in the [repository](https://github.com/sadigaxund/markii); start with
[the format guide](https://github.com/sadigaxund/markii/blob/main/docs/format.md)
to learn everything a document can contain, or install the Markii VS Code
extension to preview `.mk.md` files in your editor.
