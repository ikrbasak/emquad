# Plan — Index

The implementation plan is split across [`plan/`](plan/). Start with
[`plan/00-overview.md`](plan/00-overview.md).

| # | Document | Purpose |
|---|---|---|
| — | [plan/00-overview.md](plan/00-overview.md) | Phases, sequencing, decisions, non-goals |
| 0 | [plan/01-phase-0-spike.md](plan/01-phase-0-spike.md) | ~~Gate~~ **Done** → [results](discovery/08-phase-0-results.md) |
| 1 | [plan/02-phase-1-rust-core.md](plan/02-phase-1-rust-core.md) | ~~`emquad-engine`~~ **Done** → [docs](phase-1/00-overview.md) |
| 2 | [plan/03-phase-2-napi.md](plan/03-phase-2-napi.md) | ~~`emquad-napi`~~ **Done** → [docs](phase-2/00-overview.md) |
| 3 | [plan/04-phase-3-typescript.md](plan/04-phase-3-typescript.md) | `@emquad/core` + `@emquad/resolver`, ESM/TS |
| 4 | [plan/05-phase-4-distribution.md](plan/05-phase-4-distribution.md) | Target matrix, prebuilds, release |
| 5 | [plan/06-phase-5-docs-benchmarks.md](plan/06-phase-5-docs-benchmarks.md) | Puppeteer comparison, docs, launch |
| — | [plan/07-testing-strategy.md](plan/07-testing-strategy.md) | Test layers — runs throughout, not a phase |

Research and evidence behind these decisions is in [`discovery/`](discovery/00-overview.md).
What Phase 1 built, and what it measured that changed the picture, is in
[`phase-1/`](phase-1/00-overview.md).

## The short version

Build `@emquad/core`: a lean Node binding for Typst. **VFS in → PDF out.** No SVG/PNG/HTML
export, no watch mode, no template DSL.

Four packages: `@emquad/core` (API), `@emquad/fonts` (default fonts),
`@emquad/resolver` (`@preview` registry), `@emquad/typst-binding-<platform>` (prebuilt native).

Four things dominate the design — the first three from
[`discovery/02-footguns.md`](discovery/02-footguns.md), the fourth found in Phase 0:

1. `FileId` is a **leaky, 65k-capped, process-global interner** → canonical paths only,
   content varies. Get this wrong and the process crashes in production.
2. `comemo`'s memo cache is **process-global** → eviction on by default. Measured: ~40 MB
   with it, ~1 GB without, for 6–10% throughput.
3. **No cancellation API exists** → no timeout option; untrusted templates need process
   isolation, not thread isolation.
4. **An empty font set yields a blank PDF with zero diagnostics** → reject it at construction.

**Phase 0 is complete — the gate is passed.** Results and the go/no-go on every decision are in
[`discovery/08-phase-0-results.md`](discovery/08-phase-0-results.md). It amends the concurrency
model (add a worker-*process* pool; threads collapse on some document shapes) and the CI matrix
(Windows targets cannot be cross-compiled).

**Phase 1 is complete.** `crates/emquad-engine` compiles a VFS to a PDF with 61 passing tests.
It amends two more things: hard rule 9's "never worse" claim about rayon pinning is wrong
single-threaded, and the default fonts carry four licenses rather than one — including
GPL-3.0-or-later. Both in [`phase-1/03-findings.md`](phase-1/03-findings.md).

**Phase 2 is complete.** `crates/emquad-napi` exposes the engine to Node with a dedicated
thread pool, bounded backpressure, and pool-owned cache eviction. It **retracts hard rule 9**:
pinning typst's rayon buys nothing under a real pool, which means the multi-run throughput
collapse is process-global contention and only the worker-*process* pool can fix it. That pool
moves to Phase 3, where Node can actually spawn processes. See
[`phase-2/03-findings.md`](phase-2/03-findings.md).

**Phase 3 is complete.** `@emquad/core`, `@emquad/resolver`, and `@emquad/fonts` are built, with
115 Node tests including rasterized golden-file comparisons. It **settles the concurrency
question**: the worker-process pool is 6.93× faster than threads on multi-run documents and
0.66× on ordinary ones, so `pool.mode` is a document-shape decision rather than a dial. It also
adds hard rule 12 — SVG text in an unregistered font family fails silently, and with no serif
family registered it vanishes entirely. Only the golden-file tests caught that. See
[`phase-3/03-findings.md`](phase-3/03-findings.md).

**Start with [Phase 4](plan/05-phase-4-distribution.md)**, after reading
[`phase-3/05-handoff.md`](phase-3/05-handoff.md).
