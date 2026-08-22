# Markii for VS Code

Preview for Markii (`.mk.md`) documents: CommonMark plus a small directive
syntax that renders components: callouts, cards, tabs, dashboard stats,
and more. See the
[format guide](https://github.com/sadigaxund/markii/blob/main/docs/format.md)
for the full picture.

## Getting started

No setup. After installing the extension:

1. Open any file ending in `.mk.md` (create one if you like; it's an
   ordinary text file).
2. Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd>
   (<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> on macOS). You can also
   click the preview icon at the right of the editor title bar, or run
   **Markii: Open Preview** from the command palette.

In a `.mk.md` file that shortcut opens the Markii preview; in a plain `.md`
file it still opens VS Code's built-in markdown preview, unchanged.

The preview opens beside the editor, follows whichever `.mk.md` file is
active, updates as you type, and matches your VS Code theme.

Something to paste into a new file to see it work:

```markdown
# Hello Markii

:::callout{type=warning title="It works"}
This is a **component**, not plain markdown.
:::

Press :kbd[Ctrl+Shift+P] anytime.
```

Directive syntax is also highlighted in the editor itself.

## Images

Both local and remote images work:

```markdown
:::figure{src="nice.png" alt="A picture"}
A picture that lives next to this note.
:::

![from the web](https://example.com/chart.png)
```

A relative `src` is resolved against the folder the note itself is in, so
`nice.png` means the `nice.png` sitting beside it and `img/nice.png` means
one in a subfolder. Images from anywhere else, outside the note's folder and
outside your open workspace, are not loaded, which is the
editor's own rule for what a preview may read.

## What v1 does and doesn't

This version renders everything in the format: directives, the standard
component set, layout wrappers, tables, frontmatter. It never runs
scripts: script blocks (the ` ```lua {name=...} ` form) show as a
collapsed marker and data-bound components (`stat`, `progress`, `chart`,
`:value[...]`) show their quiet empty states. Script execution is a
planned later version.

The extension contains no rendering logic of its own; it hosts
`@markii/react`, the format's reference renderer, in a webview. What the
preview shows is by definition what the reference implementation renders.

## For contributors

Everything below is for developing the extension inside the
[markii monorepo](https://github.com/sadigaxund/markii); none of it is
needed to use the extension.

Run and debug: open the repo root in VS Code, `npm install` from the repo
root, `npm run build -w markii-vscode`, then launch with F5 ("Run
Extension") or `code --extensionDevelopmentPath=apps/vscode`. A
`.vscode/launch.json` is not committed; a single `extensionHost`
configuration with `--extensionDevelopmentPath=${workspaceFolder}/apps/vscode`
makes F5 work.

Syntax highlighting is an injection grammar
(`syntaxes/markii-directives.injection.json`) layered on the built-in
markdown grammar. One trade-off: on a fence line (` ```lua {name=stars} `)
the built-in grammar claims the whole line first, so the injected rule for
that `{...}` group is inert there. That is accepted, because never disturbing the
fence's own code highlighting matters more.

Packaging: `npm run package -w markii-vscode` produces a `.vsix`
(gitignored). Publishing to the Marketplace is a separate manual step
requiring a publisher account.
