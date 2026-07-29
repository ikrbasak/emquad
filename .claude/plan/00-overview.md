# Implementation Plan — Overview

Goal: ship `@emquad/core`, a lean Node binding for Typst. **VFS in → PDF out.**
Fast, reliable, prebuilt for many platforms, with a fluent TypeScript API.

Findings that drive this plan are in [`../discovery/`](../discovery/00-overview.md).
**Read [`../discovery/02-footguns.md`](../discovery/02-footguns.md) before writing any code** —
three process-global Typst behaviors dictate the API shape, and they are painful to retrofit.

## Phases

| Phase | File | Outcome |
|---|---|---|
| 0 | [01-phase-0-spike.md](01-phase-0-spike.md) | Empirical answers to 5 open questions. **Gate.** |
| 1 | [02-phase-1-rust-core.md](02-phase-1-rust-core.md) | **Done.** `emquad-engine` → [`../phase-1/`](../phase-1/00-overview.md) |
| 2 | [03-phase-2-napi.md](03-phase-2-napi.md) | **Done.** `emquad-napi` → [`../phase-2/`](../phase-2/00-overview.md) |
| 3 | [04-phase-3-typescript.md](04-phase-3-typescript.md) | `@emquad/core` TS API + package resolver |
| 4 | [05-phase-4-distribution.md](05-phase-4-distribution.md) | CI matrix, prebuilds, release |
| 5 | [06-phase-5-docs-benchmarks.md](06-phase-5-docs-benchmarks.md) | Puppeteer comparison, docs, launch |

Testing is not a phase — it runs throughout. See
[07-testing-strategy.md](07-testing-strategy.md).

## Sequencing

**Phase 0 is complete — the gate is passed.** All five questions are answered in
[`../discovery/08-phase-0-results.md`](../discovery/08-phase-0-results.md). Each of the three
architecture-changing risks resolved:

- Runaway mitigation *does* exist for the common cases, but memory bombs and unbounded `for`
  loops still require process isolation — as anticipated.
- Memory does **not** grow unboundedly with eviction on; RSS plateaus at ~40 MB over 100k
  compiles.
- Throughput scales with pool size **for simple documents only**. This one did not come back
  clean, and it amends the concurrency model (see below).

Phases 1–3 are mostly sequential (each builds on the last), but the TS package resolver
(Phase 3) is independent of the Rust work and can proceed in parallel from the start —
it touches no Rust code at all.

The `psm`/`stacker` verification previously flagged for pull-forward is **done**. It was not the
risk it appeared to be; the real distribution constraint is that Windows targets need native
runners.

## Decisions — with Phase 0 go/no-go

Phase 0 is complete. Results and evidence:
[`../discovery/08-phase-0-results.md`](../discovery/08-phase-0-results.md).

| Area | Decision | Phase 0 verdict |
|---|---|---|
| Fonts | Separate `@emquad/fonts` | **Go** — but an empty font set must be a hard error (see below) |
| `@preview` packages | Enabled, resolver in **TypeScript** | **Go** — untouched by Phase 0 |
| Concurrency | Dedicated Rust pool + `compileSync()` | **Go, amended** — add a worker-*process* pool |
| Cache eviction | **On by default** | **Go** — 40 MB vs ~1 GB; default `max_age` 16, not 2 |
| Targets | Wide native + `wasm32-wasip1` fallback | **Go** — all 14 verified; Windows needs native runners |
| Distribution | napi `optionalDependencies`, no postinstall | **Go** — untouched by Phase 0 |
| Typst version | Pinned exact (`=0.15.1`) | **Go** — reinforced; 0.15 changed guard behavior |

### Amendments Phase 0 forces

1. **Worker-process pool is now a deliverable, not a maybe.** Threads collapse to 0.46× on
   documents with many page runs where processes scale to 5.18×, and process isolation is also
   the only answer for runaway compiles. One mechanism, two justifications. It must be a
   *reusable* worker — process-per-compile is 11.2× slower.
2. **Pin typst's internal rayon to 1 thread**, in-process rather than via `RAYON_NUM_THREADS`.
   Worth up to 43%, never worse.
3. **Reject an empty `FontBook` at construction.** Missing fonts currently yield a valid, blank
   PDF with zero diagnostics — the exact silent-failure mode this project exists to avoid.
4. **Guard the `FileId` interner at ~50,000**, with a message naming the offending path pattern.
   The real cap is 65,535 and `catch_unwind` does contain the panic.
5. **Document `tagged`'s 4× output-size cost** prominently. Keep the default of `true`.

## Non-goals

Explicitly out of scope — say no to these to keep the package lean:

- SVG / PNG / HTML export (PDF only)
- Incremental/watch mode
- A document AST or template DSL in TypeScript — users write Typst
- Reimplementing `typst-cli`
- Rendering untrusted templates safely in-process (not achievable; see footgun #3)

## Definition of done

- Compiles a realistic invoice with custom fonts, images, tables, and colors to PDF
- Prebuilt binaries install cleanly on every matrix target
- Bounded memory over a sustained 100k-document run
- Diagnostics report file, line, and column
- Benchmarked against Puppeteer with published numbers
- Test suite per [07-testing-strategy.md](07-testing-strategy.md), green in CI
