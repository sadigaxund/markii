# Bundles and vaults

A single `.mk.md` file is the normal form of a note and always will be. This
page covers the two container concepts around it: the bundle, which packages
a note with its files, and the vault, which is the folder where your notes
live.

## Why bundles exist

Two problems turn out to be the same problem: where do a note's images live,
and where does a script too long for the page live? The proven answer, the
one TextBundle, `.epub`, and `.docx` all use, is a folder with a manifest,
optionally zipped. Markii adopts it directly.

```
note.mk.md          plain single file: first-class, never deprecated

note.mkz/      a bundle: the same note plus everything it needs
  manifest.json     format version, permissions, script declarations
  note.mk.md        the document itself, unchanged syntax
  assets/           images and attachments
  scripts/          script files referenced by src=
  .cache/           script outputs and fetched data: disposable
```

The document itself never grows blobs. Images and long scripts live beside
it inside the bundle, links stay relative, and moving the bundle moves
everything, so nothing can dangle. The note and its dependencies become one
object.

## Two forms, one bundle

The directory form is the working form: it diffs in git, greps, and opens
with any tool. The zip form, a single `note.mkz` file, is the
interchange form, one artifact to send someone. An application treats them
identically. Bundles from earlier releases used the longer `.mkbundle`
extension; applications keep recognizing it, but new bundles are `.mkz`.

## The cache is disposable

`.cache/` belongs to the host, never to the author. It holds script outputs
and fetched data, all of it regenerable. Deleting it must never lose
authored content. It is dot-prefixed so file browsers hide it by default.

## When to promote a file to a bundle

Promote for portability: when images, long scripts, or data need to travel
with the note. Never promote just to make values persist between sessions.
Persistence is governed by three invariants that hold for files and bundles
alike:

1. Rendering never executes a script.
2. The host never writes authored files; a note is edited only by its
   author.
3. Caches are disposable; deleting one loses no authored content.

Within those rules, where a host keeps last-run values is host policy. A
good application persists them in its own storage, keyed by note identity,
so a plain `.mk.md` file reopens with its last-known values while the vault
directory stays byte-identical. A bundle's `.cache/` is the portable form of
the same cache, the one that travels inside a zipped bundle, not the only
sanctioned one.

## Vaults

A vault is just a directory of notes: `.mk.md` files and `.mkz` bundles
side by side, plus at most one optional extra, a vault library of shared Lua
modules (see [scripting.md](scripting.md)). Nothing else lives there.

Everything shared is referenced by name, never by path. Component packs are
installed in the application, not the vault, because they are compiled code
that must build into the host; Lua may live vault-side because it is
interpreted source the sandbox runs from text. The vault-published value
store is application-side too, so publishing adds no files.

Namespace collisions are handled with flat, boring rules: installing two
packs with the same namespace is rejected at install time, and a vault
library that shadows an installed pack wins, with a visible warning. There
is no transitive resolution and no version ranges, deliberately.

## The manifest

`manifest.json` is the bundle's identity card. It records the spec version
in its required `mark` field, declares the note's scripts, and lists the
permissions the note wants (see [security.md](security.md)). Scripts can
never write it: a script that could edit the manifest could grant itself
permissions, so the file is load-bearing and host-owned.
