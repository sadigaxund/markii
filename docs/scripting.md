# Scripting

A Mark document can fetch data, transform it, and display it, without turning
into a program. This page explains the whole scripting model: how scripts
run, where their values go, and how code is shared between notes. It assumes
you've read [format.md](format.md).

## The model: scripts are data providers

A script block runs, returns a value, and that value gets a name. Directives
consume the value by name. That is the entire relationship between code and
document:

````
```lua {name=stars}
local repo = net.fetch_json("https://api.github.com/repos/x/y")
return repo.stargazers_count
```

::stat{data=stars label="GitHub stars"}
````

Scripts never write into the document body. There are no self-modifying
notes. The document stays declarative, prose and components, and scripts
feed them.

The test for whether a note has crossed the line into being a program: delete
every script block. If a coherent note remains, you're fine. If nothing
readable is left, it was a program wearing a note costume.

## Writing a script block

A script is an ordinary fenced code block whose info string carries a
`{name=...}` attribute:

````
```lua {name=stars}
return 42
```
````

Plain markdown viewers show it as a highlighted code block, which is exactly
the point: no new syntax, nothing to break.

Only a block carrying `name=` (or `src=`, below) is runnable. A bare
` ```lua ` block is display-only and never executes, so example code can sit
in a note harmlessly. The attribute is the sole switch between the two.

A script name must match `[A-Za-z_][A-Za-z0-9_-]*`. Dots in particular are
not allowed, because value lookups read a dot as path traversal (`repo.stars`
reaches into a returned object), which would make a dotted name unreachable.
A block with an invalid name is treated as display-only, not as an error.

Boolean attributes in the fence meta, like `publish`, are bare-only: you
write `publish`, never `publish=true`. Any spelled-out value counts as
absent. This fails closed, so an unrecognized spelling can never switch
behavior on.

How a runnable block *looks* in a rendered page is the renderer's choice, not
the format's. The reference renderer folds it to a collapsed one-line marker
(`⚙ stars · lua`) that expands on demand; a reading view may hide it
entirely. The only rule is that the code stays in the file, so a plain
viewer always shows it and hiding it in a polished view never costs
portability.

## Where values go

Every named script's return value lands in a per-note value store. Two
constructs read from it:

- `:value[stars]` renders the value inline in prose.
- `data=stars` on a directive feeds it to a component.

Both accept a dotted path to reach into a returned object or array:
`:value[repo.stars]`, `data=repo.spark`. Path lookup reads own properties
only, so it can never traverse into anything the script didn't return.

If a value is missing, or a script hasn't run yet, the consumer shows a quiet
empty or stale state: a placeholder marker for `:value`, an empty body for a
data-bound component. When a run has failed, the reason appears as a hover
tooltip on that placeholder, never as error text in the page. A document
never breaks because its data isn't there yet.

## Rendering never runs code

Opening a note executes nothing. Rendering only reads last-known values from
the host's cache, so a note opens instantly and offline, showing its last
data marked as stale where appropriate.

Running is a separate, explicit event, and how a run was triggered caps what
the script may do:

| Trigger | Allowed capabilities |
|---|---|
| Manual run (a click) | everything the note was granted, including effectful operations |
| Auto-run on open (opt-in) | read-only tier: GET requests, cache and bundle reads, cache writes |
| Scheduled (opt-in) | read-only tier |

The rule mirrors the browser's user-activation model: effects always cost a
click. An effectful call under an auto trigger fails cleanly, and the
consuming component shows a "requires manual run" hint in its tooltip. The
tier limits are enforced by the host, not promised by convention; the
security details live in [security.md](security.md).

Schedules live in the application, never inside a script. There are no
timers in the sandbox.

## Freshness

`cache.get(key, ttl, fn)` is the one-line "fetch unless fresh" helper:

```lua
return cache.get("gh", 3600, function()
  return net.fetch_json("https://api.github.com/repos/x/y")
end)
```

The TTL doubles as a rate limiter, even for manual runs. Consumers always
see the usual freshness status: fresh, stale, or missing.

One habit is worth building early: validate inside the function you hand to
`cache.get`. The cache stores whatever that function returns, and APIs
sometimes return an error body with a 200 status. Stored once, a bad reply
is served for the whole TTL. Raising instead keeps it out:

```lua
return cache.get("gh", 3600, function()
  local r = net.fetch_json("https://api.github.com/repos/x/y")
  if r.message then
    error("GitHub API: " .. r.message)
  end
  return r
end)
```

An error inside the function aborts the run before anything is stored, so
the cache only ever remembers good data, and the last good value keeps
serving consumers through an API hiccup.

## Sharing values between notes

Values are note-scoped by default. Cross-note sharing, the case where one
note's data collection feeds many notes' dashboards, goes through exactly
one mechanism: publishing.

A script fence with the bare `publish` attribute copies its returned value,
after a successful run, into a vault-wide store managed by the application:

````
```lua {name=gh publish}
return cache.get("gh", 3600, function()
  return net.fetch_json("https://api.github.com/repos/x/y")
end)
```
````

Any other note in the vault reads it with an `@` prefix:

```
::stat{data=@gh.stargazers_count label="Stars"}
```

The whole mental model is one sentence: a bare name is mine, an `@` name is
the vault's.

The rules are flat on purpose. One writer per published name; the
application rejects a second note publishing an already-claimed name.
Readers are read-only, so there is no shared mutable state, only
single-writer snapshots with the usual freshness status. Reading an `@`
value is pure and needs no permission; publishing writes beyond the note, so
it requires a grant. Publishing adds no files to the vault; the store lives
in the application.

## Long scripts and shared code

A long script doesn't have to bloat the note. Inside a bundle, the block can
become a one-line reference with an empty body:

````
```lua {src=scripts/etl.lua name=stars}
```
````

The code lives in the bundle's `scripts/` folder, the note keeps a visible
marker, and prose stays prose.

Shared code enters through a sandboxed `require` with exactly three sources:

1. **Bundle-local modules**: `require "scripts/util"`, resolved inside the
   same bundle.
2. **Pack modules**: `require "ana/http"`, shipped by an installed component
   pack under its namespace. See [packs.md](packs.md).
3. **The vault library**: `require "mylib/etl"`, a folder of plain `.lua`
   files inside the vault that the application maps to a namespace. This is
   the "maintain my helpers once, use them in every note" answer for a
   single vault; code meant to travel beyond one vault belongs in a pack.

The three are told apart by the first path segment. The bundle's structural
directories, `scripts`, `assets`, and `.cache`, are reserved: a name starting
with one of them always resolves inside the bundle and can never be a pack
or library namespace. Every other first segment is a namespace. All required
code is pure Lua; a `require` that can't resolve fails softly, and the
consuming script reports "requires library `mylib`" in the same graceful way
an unknown component falls back.

There is deliberately no package manager: no luarocks, no network `require`,
no dependency resolution. Fetching code from the network is code injection
into a note, and packs already are the distribution unit for shared code.

## The language

Scripts are Lua 5.4, and the choice was made on embedding strength rather
than fashion. Lua's runtime is about 200 KB, builds to WebAssembly, starts a
fresh isolated environment in microseconds, and supports instruction-count
hooks for cheap timeouts. Its syntax is plain enough to read as executable
pseudocode, and decades of game modding give it good documentation coverage.
The runtime ships inside the host application, version-pinned; users never
install it, and notes never carry it.

What actually makes scripting approachable is the host API, which is kept
small, flat, and holdable in one head:

- `net.fetch_json(url)`: fetch and parse JSON from a granted host
- `cache.get(key, ttl, fn)`: return cached value or compute and store it
- `bundle.read(path)` / `bundle.write(path, data)`: bundle-scoped files

What these hand back is ordinary Lua data, with no wrapper objects and no
special access rules. A fetched result is a plain table: `type()` says
`"table"`, `#` and `ipairs` work on arrays, and any part of it can go
straight into the script's return value. A JSON `null` follows one simple
rule: as an object field it is simply absent, so reading it gives `nil`
rather than an error; inside an array it becomes `false`, so the array
stays dense and `#` still tells the truth. A value served from the cache
comes back in exactly the same plain shape it was stored in. None of this
needs a defensive `pcall`. Responses are bounded by the sandbox's size
limits; a response too large or too deeply nested fails the fetch with a
clear error instead of reaching the script partially.

The available Lua standard library is a curated slice: `string`, `table`,
and `math`. There is no `os`, no `io`, and no raw `require`; everything a
script can touch is either that slice or a capability the host granted. The
enforcement behind this is described in [security.md](security.md).

Script blocks are tagged with their language (` ```lua {name=...}` `), so
other runtimes can be added later as optional extensions without touching
the format.

## Fence-meta grammar, precisely

For implementers and the curious: the first `{...}` group in a fence's info
string holds whitespace-separated attributes of the forms `key`, `key=bare`,
`key="quoted"`, or `key='quoted'`, and quoted values may contain braces. This
grammar is normative and deliberately mirrors directive attributes; the
conformance corpus pins its edge cases. Script blocks may appear anywhere
markdown may, including inside containers, and their names all land in the
same note-scoped store regardless of position.
