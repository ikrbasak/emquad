# Architecture

Every design decision below traces to something measured in Phase 0. Where a choice looks
over-engineered, the footgun it defends against is named.

## The one-paragraph version

A long-lived [`Compiler`] owns the three expensive things — the standard library, the parsed
fonts, and the base VFS layer — and is cheap to clone and share. Each compile builds a small
`Overlay` on top of that base, wraps both in an `EmquadWorld` implementing typst's seven-method
`World` trait, and runs `typst::compile` + `typst_pdf::pdf` inside `catch_unwind`. Diagnostics
come back with resolved file/line/column. Nothing expensive is rebuilt per compile, because
rebuilding it would invalidate the `comemo` memo cache and destroy throughput.

## Data flow

```
Compiler::builder()                            ← once, at startup
  .font(bytes)                                 → FontRegistryBuilder
  .source("/templates/invoice.typ", …)         → WorkspaceBuilder  ─┐
  .package_file("@preview/cetz:0.4.2", …)                           │ paths interned here,
  .build()?                                                         │ not on the hot path
       │                                                            │
       ├─ Arc<LazyHash<Library>>   built once                       │
       ├─ FontRegistry             parsed once, Arc-shared          │
       └─ Workspace                Arc<HashMap<FileId, Bytes>> ─────┘

compiler.compile()                             ← per request
  .main_source(text)                           → Overlay { "/main.typ": text }
  .file("data.json", bytes)                    → Overlay
  .clock(Clock::fixed(…))
  .pdf(PdfSettings { … })
  .run()?
       │
       ├─ validate PdfSettings                 ← fails before any compile work
       ├─ intern main path, check it exists    ← MainNotFound, not a typst error
       ├─ EmquadWorld { library, fonts, base: &Workspace, overlay: &Overlay, main, clock }
       ├─ rayon::pinned(…)                     ← confines typst's page-run parallelism
       │    └─ catch_unwind(…)                 ← hard rule 2: a panic must not reach Node
       │         ├─ typst::compile::<PagedDocument>(world) → Warned<Result<_, Vec<Diag>>>
       │         └─ typst_pdf::pdf(&document, &options)
       └─ CompileOutput { pdf, warnings, pages }
```

## Module by module

### `paths.rs` — the interning guard

**The problem.** `typst_syntax::FileId` is a process-global interner. Every distinct
`RootedPath` is `Box::leak`'d, entries are never freed, the id is a `NonZeroU16`, and
allocation past 65,535 panics with `out of file ids: TryFromIntError(PosOverflow)`. A server
that names files per request — `invoice-${uuid}.typ` — leaks permanently and takes the process
down at ~65k renders.

**The response.** `intern()` is the only place in the crate that constructs a `FileId`. It
keeps its own map, which does two jobs:

- **Fast path.** Repeat lookups are served under a read lock. `FileId::new` takes typst's
  global *write* lock unconditionally, even for paths it already knows, so this also keeps
  concurrent compiles off a global write lock.
- **The guard.** A high-water mark trips at `DEFAULT_LIMIT` (50,000), well below typst's
  65,535, and returns `Error::PathVocabularyExhausted` instead of letting the panic happen.

Two details worth keeping:

- **The high-water mark reads typst's counter, not ours.** `FileId::into_raw()` *is* the
  interner index, so paths typst interned on its own (resolving relative imports, walking into
  packages) show up as a jump in that number. Counting only our own calls would undercount.
- **The error names the pattern, not just the path.** "You are out of file ids" is useless
  without knowing which template produced them, so `family()` folds variable-looking runs into
  `*` and the error reports the dominant family:
  `23,481 interned paths match /invoice-*-*-*-*-*.typ`. It over-groups deliberately — the
  function is only consulted at 50,000 distinct paths, where whatever dominates *is* the
  problem.

`FileId::unique` (formerly `new_fake`) is never used: it skips deduplication and makes the leak
strictly worse.

### `vfs.rs` — two layers, two lifetimes

| Layer | Lifetime | Contents | Cost per compile |
|---|---|---|---|
| `Workspace` | long-lived, shared | templates, logos, mounted packages | `Arc` clone |
| `Overlay` | one compile | `main.typ`, this request's data | small `HashMap` |

Resolution is overlay → base → `NotFound`. The base is behind an `Arc`, so concurrent compiles
cannot tear it and an overlay write can never reach it — there is a test for exactly that,
because a leak there would corrupt every other in-flight compile.

Keeping the base stable is not an optimization. `comemo` memoizes against the `World`, so
rebuilding the base between compiles throws the memo cache away (hard rule 6).

`NotFound` carries the VFS path rather than the `FileId`, because a diagnostic naming an opaque
integer helps nobody.

### `fonts.rs` — and why an empty registry is an error

Phase 0 found this and it is the reason the project's testing strategy exists: **with no fonts
registered, typst compiles successfully and emits a valid PDF in which every text run — body
text included, not only SVG — is silently dropped, with zero diagnostics.** A test asserting
only "no error thrown" passes that.

So `FontRegistryBuilder::build()` returns `Error::NoFonts` on an empty set (hard rule 8).

Other decisions here:

- **`add()` returns a face count rather than erroring** on unparsable data. A caller feeding a
  directory usually wants the count, not an abort on the first `.DS_Store`. An entirely empty
  result still fails at `build()`, so it fails closed.
- **`font(index)` tolerates out-of-bounds indices.** Typst documents that `World::font` may be
  called with indices from an outdated font book during incremental compilation validation.
  Returns `None`; never panics.
- **`extended_with()` returns a new registry** rather than mutating. Adding fonts rebuilds the
  `FontBook`, which invalidates the memo cache — the signature makes that visible instead of
  hiding a throughput cliff behind an innocuous-looking method.
- **Family names keep their case.** Typst lowercases only for suffix matching; `Inter-Variable.ttf`
  reports `Inter` because `variable`, `var`, and `vf` are trimmed along with weight and width
  suffixes. Verified against the shipped fonts, not assumed.

### `world.rs` — the blast radius of a typst upgrade

All seven methods, one small module, nothing else in it. When the `=0.15.1` pin moves, this
file and `paths.rs` are what break. `source()` decodes from the same byte store as `file()`, so
the two can never disagree about what a path contains.

### `clock.rs` — reproducibility, without a timezone database

`World::today` is the only way a compile observes the outside world, and therefore the only
thing that stops output from being reproducible. Making it injectable lets tests pin it and
lets callers ask for byte-identical PDFs.

There is deliberately **no local-time support**. Resolving a local date needs a timezone
database — a dependency whose only job is to answer a question the host already knows the
answer to, since Node reports the offset via `Date.prototype.getTimezoneOffset()`. The offset
is passed in and this module does arithmetic on it. `civil_from_days` is Howard Hinnant's
algorithm: twenty lines, exact, tested against the 2000 leap year and the 1900 non-leap
century, and no dependency.

### `diagnostics.rs` — the actual differentiator

The existing binding reports formatted strings. This crate resolves positions, and that is the
main reason to prefer it.

- **1-based line and column**, converted from typst's 0-based `Lines` API in exactly one place.
- **Columns count characters, not bytes.** There is a test with astral-plane characters where
  byte counting would report column 19 instead of 7.
- **Hints are preserved, with their own positions.** Typst 0.15 lets a hint point at different
  code than the error. They are the actionable half of most messages.
- **Warnings survive success.** `typst::compile` returns `Warned<T>`; a successful compile still
  carries them, and they are the most likely place a silently-wrong document announces itself.
- **Traces are kept.** Without them there is no way to locate an error inside an imported file
  or a `@preview` package.
- **On error, warnings are appended rather than dropped.** A warning is often the explanation
  for the error above it; `severity` keeps them apart.

### `pdf.rs` — validated before anything expensive happens

An owned mirror of `typst_pdf::PdfOptions` — owned because these values cross an FFI boundary
in Phase 2. Validation happens up front, which turns two late failures into argument errors:

- Incompatible standards (`PdfStandards::new`), with typst's hints preserved.
- **`tagged: true` with `page_ranges`.** Typst rejects this at export, after the whole compile
  is paid for, with no position and no hint. Ours fails immediately and says
  `set tagged: false to export a page range`.

`tagged` defaults to `true`, matching upstream. Phase 0 measured the cost as +5–28% time but
**up to +302% output size** — the size is what to weigh, and turning it off to improve a
benchmark would be an accessibility regression users would not notice.

### `compile.rs` — the fluent builder

Chained methods can fail (a path can be invalid, the interner can be exhausted), so the first
error is held in `deferred` and surfaced at `run()`. That keeps the builder chainable without
`?` on every line.

`main_source(text)` writes to `/main.typ` and points `main` at it. That is the normal entry
point and it encodes hard rule 1 directly: **content varies per request, the path never does.**

Three things happen inside `run()` in this order, and the order matters:

1. **Settings validation** — cheapest failure first.
2. **Main-file existence** — `MainNotFound` naming the path, rather than a typst file error.
3. **`rayon::pinned(catch_unwind(...))`** — hard rule 2. A panic crossing this boundary would
   abort the host process.

There is deliberately **no `timeout` option** (hard rule 3). Typst has no cancellation hook and
a Rust thread cannot be forcibly killed, so a timeout would leak a wedged thread while looking
like protection. Untrusted templates need process isolation, which is Phase 2's job.

### `rayon.rs` — read it before changing the default

`typst-layout` parallelizes over *page runs*, which are created by page re-configuration rather
than by page count, so an ordinary document has exactly one and rayon never engages. Documents
that create many runs behave very differently.

Pinning uses a thread-local one-thread pool built with `use_current_thread()`, so the work runs
inline with no hand-off and no extra threads — not `RAYON_NUM_THREADS`, which is process-global
and would shrink a host application's own pool.

**Phase 1 measured that this is not free**, contradicting part of hard rule 9. The numbers, the
method, and what Phase 2 has to decide are in [`03-findings.md`](03-findings.md).

### `cache.rs` — eviction is the pool's decision

`comemo` is process-global and unbounded; nothing evicts it unless someone calls `evict`.
Phase 0's 100,000-compile run measured ~40 MB with eviction against ~1 GB without, for 5.9%
throughput at `max_age = 16`.

Eviction is deliberately **not** automatic here. The engine does not know how many compiles are
in flight, and calling it mid-flight on one thread discards work another thread is about to
reuse. The pool owns the policy.

## Concurrency

`Compiler` is `Send + Sync` and cheap to clone. Compiles from many threads share the base VFS
and the font registry through `Arc`.

`compiles_are_deterministic_under_concurrency` runs 16 compiles serially and then in parallel
and asserts byte-identical output. That test targets the process-global state directly —
`comemo`, the `FileId` interner, and the font book are all shared, and it is exactly where a
snapshot-isolation bug would hide.
