# Architecture

Three packages, one compiler seam, two pools.

```
                     @emquad/fonts          @emquad/resolver
                     (17 files, 4 licenses)  (all networking)
                            │                       │
                            │  FontSource[]         │  PackageFile[]
                            ▼                       ▼
                    ┌───────────────────────────────────────┐
                    │            @emquad/core               │
                    │  Compiler ── document() ── Document   │
                    │      │                        │       │
                    │      └── CompileBackend ◄─────┘       │
                    │            ╱          ╲               │
                    │  ThreadBackend      ProcessPool       │
                    └──────┬──────────────────┬─────────────┘
                           │                  │ fork + IPC
                           ▼                  ▼
                   @emquad/typst-binding      worker.js × N
                   (napi addon)         each → @emquad/typst-binding
```

`@emquad/fonts` and `@emquad/resolver` have **no dependency on `@emquad/core`**, in either
direction at runtime. They produce plain data — font descriptors and package files — that
`@emquad/core` accepts structurally. That keeps the resolver's dependency count at zero and means
a user who brings their own fonts installs neither.

## `@emquad/core`

### The binding seam

`src/binding.ts` is the only file in the package that names `@emquad/typst-binding`. Everything else
imports through it. That is deliberate: `@emquad/typst-binding` is internal to this repo and is never
published, so Phase 4 has to change how the addon is located — vendoring the generated loader and
depending on `@emquad/typst-binding-<platform>` optional packages. When it does, this is the one
file that changes.

### `Compiler` — validation and backend choice

The constructor does three things and nothing else: validate options, resolve font descriptors,
and construct a backend.

Two of the validations are worth their existence:

- **Empty font set → `NO_FONTS`.** The engine rejects it too, but catching it here buys a message
  that names the option. It exists because typst compiles *successfully* with no fonts and emits a
  valid PDF with every text run silently dropped and zero diagnostics.
- **`pool.timeoutMs` without `pool.mode: "process"` → `INVALID_ARGUMENT`.** Refused rather than
  ignored. Honoring it in thread mode would mean reporting a timeout while the compile ran on
  forever holding a thread, which is precisely the fake protection hard rule 3 forbids.

### `Document` — a request, not a compiler

Cheap to create and throw away. It accumulates a request and hands it to the backend.

Two decisions inside it are load-bearing:

**Nothing is prepended to user source.** A prelude injected on the caller's behalf would shift
every line number in every diagnostic by a constant, and exact positions are most of what makes a
compile error useful. This is why `.data()` mounts a JSON file rather than emitting `#let`
bindings.

**`.data()` writes JSON, never generated typst.** Generated source would need escaping correct for
every string a caller might pass, and getting that wrong is a template injection. `json()` has no
such failure mode, and typst turns the result into real values.

### Paths are canonical

Every path-taking method is a *slot*, not a filename. `FileId` is a process-global interner that
is never freed, is capped at 65,535, and **panics** when exhausted — so `invoice-${uuid}.typ`
leaks permanently and aborts the process at ~65k renders.

The API makes the safe form the ergonomic one: `.source(content)` always writes `/main.typ`, and
`.asset("/logo.png", bytes)` overrides one stable path with different bytes per tenant. There is
no heuristic rejecting suspicious paths — it would produce false positives on legitimate
structure. Instead `stats().internedPaths` is exposed, the Rust guard trips at 50,000 naming the
offending *pattern*, and the discipline is documented everywhere a path is accepted.

## The two backends

Both implement `CompileBackend`. That interface is what lets `pool.mode` be a one-word
configuration change rather than a different API.

### `ThreadBackend` — the default

A thin wrapper over the napi `Compiler`. No startup cost beyond parsing fonts once, no IPC, and
PDFs come back without copying (`Buffer::from(Vec<u8>)` hands ownership to V8).

`close()` is a no-op. The Rust pool's threads are detached OS threads rather than libuv workers,
so they do not hold Node's event loop open.

### `ProcessPool` — isolation

N forked Node processes, each holding its own `Compiler`, each using `compileSync`. Everything
process-global in typst is global *to that worker*.

**Why it exists** — two independent problems, one mechanism, both measured:

- **Throughput.** Multi-run documents get *slower* as threads are added: 0.32× at eight threads.
  Processes reach 2.35× and are **6.9× faster than threads at eight**. Phase 2 eliminated rayon as
  the cause, which places the contention in process-global state. See
  [`03-findings.md`](03-findings.md).
- **Runaway templates.** Typst has no cancellation hook and a Rust thread cannot be killed. A
  process can. This is the only real mitigation for untrusted input.

**What it costs.** ~44–100 ms of startup against ~4 ms, every request and PDF copied across a
process boundary, and 0.66–0.87× the throughput on ordinary single-run documents.

#### Design notes that are not obvious from the code

**`serialization: "advanced"`.** The channel carries fonts and PDFs. The default `"json"`
serialization would stringify every byte of them.

**`execArgv: []`.** `fork` inherits the parent's V8 flags by default. Under `node --test` that
includes `--test`, and every worker would start its own test runner instead of compiling
anything.

**`poolSize: 1` inside each worker.** A worker has one job at a time; a larger pool inside it would
reintroduce the in-process contention the design exists to avoid.

**Killing retires before it kills.** Process death is asynchronous. A worker marked `ready` while
dying will be handed the next job — see finding 6. `#expire` clears `ready` first, and `#dispatch`
checks `child.connected` and requeues rather than writing into a closed channel.

**Init failure is sticky.** A font that will not parse fails identically in every worker. Without
a terminal state the supervisor would respawn into the same failure forever, turning a
configuration mistake into an invisible busy loop. `maxRestarts` (default 10) bounds the other
direction.

**Backpressure refuses rather than blocks.** Same contract as the Rust pool. Blocking would convert
a load spike into unbounded latency and hide the overload; `QUEUE_FULL` lets the caller shed load.

**`compileSync` throws.** There is no synchronous path across a process boundary. Falling back to
an in-process compile would be worse than failing — the caller asked for isolation and would
silently not get it.

**`stats()` reports the maximum across workers, not the sum.** These counters predict a hard abort
at typst's per-process 65,535-path cap, so the worker nearest it is the one that matters. A sum
would read as alarming long before any single process was at risk.

## `EmquadError`

The binding **returns** `{ ok: false, error }` because a rejected promise can only carry a
`napi::Error` — a message and a status, with nowhere to put diagnostics. This layer converts that
into a thrown `EmquadError` carrying `code`, `diagnostics`, and the first error's `file`, `line`,
`column`, `severity`, and `hints` as real fields.

"First" means the first diagnostic with severity `error`, falling back to the first of any
severity. Typst can report a warning ahead of the error that actually stopped the compile, and
surfacing the warning's line as `err.line` would point the caller at the wrong place.

Usage errors thrown by the binding encode their code as a `[CODE] ` message prefix. `normalizeThrown`
parses it — the only place in the codebase that reads a code out of a string, so everything
downstream sees a field.

## `@emquad/resolver`

Zero runtime dependencies, including the tar reader (~80 lines; the format is 512-byte headers,
and a tar library is a lot of code to trust with archives fetched over the network).

**Why resolution happens before compiling.** Typst's `World::file` is synchronous, so a package
cannot be downloaded during a compile. The resolver prescans source text with a regex for import
specs, fetches those, then prescans *their* sources for transitive imports until nothing new
appears. The regex over-matches — a spec in a comment counts — which is the right direction to be
wrong in: a spurious fetch costs one cached download, a missed one fails the compile.

**Three tiers, and the claim that matters.** Memory → disk (shared with `typst-cli`, so a machine
that has used the CLI starts warm) → network. In-flight requests are deduplicated, without which
concurrency alone would break the guarantee. `networkFetches` is exposed so "once per version,
never per compile" is assertable rather than asserted.

**Integrity is computed over the extracted files, not the tarball.** The lockfile has to be
verifiable on every disk-cache read, and by then the tarball is gone — hashing the archive would
mean the check only ran on the path that needed it least. Paths are sorted and length-delimited so
neither filesystem ordering nor a path/content boundary can change the result.

**A mismatched package is never written to disk.** Verification happens before the cache write, so
a bad download cannot become tomorrow's cache hit.

**`typst.toml` is mandatory** and its absence is caught at download. Typst reads the manifest to
find the entrypoint; without it an import fails with a file-not-found naming a path the user never
wrote, which is a genuinely baffling error to receive.

## `@emquad/fonts`

A data package, and the only one in the workspace that is not MIT. `src/manifest.ts` is generated
by `scripts/sync.mjs` and records each file's license, size, and SHA-256.

The checksums are the mechanism behind hard rule 11: `NewCM10-Regular.otf` is GPL-3.0-or-later,
and the Distribution Exception that lets a permissive package carry it is void the moment glyphs
are added, removed, or re-encoded. A build step that helpfully subset the fonts would silently
relicense the package as GPL-3. `test/fonts.test.js` compares every file against both its
recorded hash and — when the crate is vendored — its `typst-assets` original.

`fontsExcept()` exists so the sanctioned way to shrink the payload is available: dropping a whole
family is a packaging choice, subsetting a file is a license change.
