# Security model

Reading a Mark document is always safe. Only running its scripts requires
trust, and that trust is granted in small, specific pieces rather than one
big dialog. This page describes the model and the current verification
status of the reference sandbox.

## No "trust this note?" dialog

A blanket trust prompt is the Word-macro model, and its history is the
history of macro malware: users click OK. Mark inverts it. Scripts are
sandboxed by default, capabilities are granted individually, and a prompt
only ever asks about one specific thing, such as network access to one
specific host. An untrusted note opened from anywhere starts with zero
grants and still renders fully, because scripts only feed values: the page
degrades to empty and stale component states, never to a broken document.

## Capabilities

A bundle's manifest declares what its scripts want:

```json
"permissions": {
  "net":    ["api.github.com"],
  "bundle": ["read", "write:.cache/"]
}
```

The host asks the user to grant each capability and injects the granted ones
into the sandbox as functions. Nothing is ambient: Lua in the sandbox has no
network, no filesystem, and no clock beyond what the host hands it.

Network grants are per-host, and the honest prompt wording matters: the
prompt must say the note "can send data to api.github.com", not that it
"wants network access". Even a read-only GET request carries data outward
through its URL, so the per-host allowlist is the real boundary, and the
wording should say so.

Grants are remembered per note, keyed by a hash of the note's full
executable closure: its inline scripts, `src=` script files, required
bundle-local modules, vault-library modules, and the versions of any pack
modules it requires. If any of that code changes, the grant is stale and the
host prompts again. Without this rule, edited shared code would silently
inherit grants that were made to different code. The reference
implementation of the key is `computeGrantKey` in `@markii/runtime`.

## Triggers cap capabilities

How a run was triggered limits what it may do, independent of what was
granted:

| Trigger | Tier |
|---|---|
| Manual run | full: every granted capability, including effectful operations |
| Auto-run on open | read-only: GET, bundle and cache reads, cache writes |
| Scheduled | read-only |

The read-only tier is enforced structurally, not on the honor system: the
read-only network function exposes no method or body at all, so there is
nothing to escalate. An effectful call under an auto trigger fails cleanly
and the consuming component shows a "requires manual run" hint.

## The sandbox

Scripts run in Lua 5.4 (wasmoon, WebAssembly) with an empty environment.
The dangerous standard libraries (`os`, `io`, `package`, `debug`,
`coroutine`) are never linked into the interpreter at all, which is stronger
than loading and deleting them; only a curated slice of `string`, `table`,
and `math` is available, with the remaining unsafe entry points (`load`,
`getmetatable`, `setmetatable`, `string.dump`, and the rest) removed by a
scrub pass. Each run gets a fresh environment; that costs microseconds, so
sandbox-per-note is cheap.

Resource limits bound every run: an instruction-count hook, a wall-clock
timeout, a memory cap, and a fetch response size cap. Limit breaches and
capability denials are recorded on the host side, outside the sandbox, so a
script cannot forge or suppress how its failure is classified.

## The isolate requirement

In-process limits are best-effort; the terminatable isolate is the real
guarantee. A WebAssembly interpreter cannot always be interrupted from
inside its own realm: an adversarial script can reach a state the
instruction hook can no longer unwind, synchronously blocking the thread it
runs on. The runtime contract is therefore normative:

**A host must run note scripts in a dedicated, terminatable isolate (a Web
Worker or worker thread) with an external wall-clock watchdog that
terminates the isolate when a run overruns.**

Auto-run and scheduled execution are only sound on top of that watchdog,
because they carry no user gesture: an auto-run note that hangs would freeze
the host on open. Manual runs share the requirement but at least fail behind
a deliberate click. No isolate ships in this repository; it is the
embedding application's code, and the host checklist in
[integration.md](integration.md) lists it first.

## The bundle jail

A script's entire filesystem is its own bundle. `bundle.read` and
`bundle.write` accept no absolute paths, no `..`, and no symlink following;
the host resolves everything inside the bundle root and rejects escapes.
Writes are limited to `.cache/` by default. A script can never write the
document (no self-modifying notes) and never `manifest.json`, since a script
that could edit the manifest could grant itself permissions. A script never
sees any other note's bundle; sharing data between notes goes through the
published-value store instead (see [scripting.md](scripting.md)).

## Verification status of the reference sandbox

The `@markii/lua` sandbox was audited adversarially in August 2026 (commit
`f7d54e8`), with every claim backed by a probe that can be re-run against
the code. The audit's approach was deliberate about its own trust model:
claims were graded by whether an attack was actually executed against the
real interpreter, and a "found nothing" verdict is bounded by the attacks
tried, which were listed so the gaps stay visible.

The core held. The empty-environment strategy, the layered limits with
host-side non-forgeable breach flags, the two-gate value marshaller (an
in-sandbox walk under the instruction hook, backstopped by a host-side
finalizer), and the capability tier gating all withstood the probe set,
which included metatable forgery, denial-message spoofing, function
smuggling, cycle attacks, and deep-recursion and large-allocation attacks.

Two findings came out of the audit, neither exploitable for escape, leak, or
hang, and both were fixed in commit `272f1b6`:

1. The marshaller's fast-rejection caps could be bypassed by rebinding the
   Lua globals the walk used, degrading a rejection from ~20k instructions
   to the full memory-cap budget. The primitives are now captured into
   locals at prelude definition time, immune to rebinding, and the run path
   gained an unconditional catch so the never-throws guarantee no longer
   depends on downstream behavior.
2. Strings containing NUL bytes were silently truncated by the interpreter's
   string marshaling. They are now rejected at the marshal boundary with an
   explicit reason instead of losing data silently.

Both fixes were verified by independent re-runs of the original probes.

A third finding was reported through real-world script writing rather than
the audit (August 2026, issue #6). The `net` capability returned fetch
results to Lua as the engine's own proxy objects instead of plain tables,
and `cache.get` did the same for a stored value on a cache hit. Proxies
leaked engine semantics into scripts: `type()` misreported them, returning
a nested piece of a result was rejected by the marshaller, and reading a
field whose JSON value was `null` raised an error instead of giving `nil`.
The fix removes proxies from the script-facing surface entirely. Fetch
responses and cache hits are decoded inside the sandbox by a trusted JSON
decoder that builds genuine Lua tables, with the depth and node caps
enforced on the host side before decoding and reported as an ordinary
capability denial. The same change bounded the cache write path: a value
being stored now passes through the same capped, cycle-safe walk a
script's own return value gets, so an oversized or cyclic value fails
cleanly instead of reaching storage. The security posture is unchanged:
nothing non-serializable crosses into the sandbox through these paths, and
the capability tier gating is untouched.

The decoder change was itself verified adversarially before merge, with
executed probes rather than review alone. That pass confirmed the decoder
introduces no escape and handles malformed input, hostile keys, and large
or deeply nested documents cleanly, and it surfaced four gaps that were
fixed before the change shipped: remote JSON could spoof the marshaller's
internal array marker and change a value's type on the host side; the
cache-hit path skipped the depth and node caps the fetch path enforces; a
script could disable the cache write bound by rebinding a global the
prelude read at call time; and the decoder resolved its own Lua primitives
dynamically, repeating the pattern the earlier audit's first finding had
already fixed in the marshaller. All four fixes carry regression tests
that re-run the original probes.

Three areas remain intentionally outside the audited surface, and are
tracked rather than forgotten: the four known hang reproductions are covered
by dedicated deadlock tests rather than re-executed in CI (re-triggering a
genuine hang would wedge the test runner); the external terminatable isolate
is the embedding host's code and does not exist in this repository; and the
`require` jail cannot be audited until the packs feature wires it up, at
which point it needs its own adversarial pass.
