# Phase 0 — Spike (Gate)

> ## ✅ Complete — gate passed
>
> **Results: [`../discovery/08-phase-0-results.md`](../discovery/08-phase-0-results.md).**
> All five questions answered, plus one unplanned finding (missing fonts produce a blank PDF
> with no diagnostics). Two answers amend the plan: the concurrency model gains a worker-process
> pool, and Windows targets cannot be cross-compiled.
>
> The document below is the original brief, kept for context. Proceed to
> [Phase 1](02-phase-1-rust-core.md).

**Purpose:** answer questions whose answers could change the architecture, before any API is
locked in. This is throwaway code. Do not build the real thing yet.

Some of this is already done — a working `World` implementation compiled a real PDF and
produced the numbers in [`../discovery/07-benchmarks.md`](../discovery/07-benchmarks.md).
What remains are the questions that could still move the design.

## Q1 — Can a runaway compile be mitigated at all?

**Why it matters:** determines whether the untrusted-template story is "documented as
unsupported" or "supported via a process pool".

Established: no `cancel`/`timeout`/`deadline`/`interrupt` API exists in Typst 0.15, and
threads cannot be forcibly killed in Rust. A `MAX_DEPTH` guard catches infinite recursion but
not long loops.

**To do:**
- Write a pathological template (tight loop, and separately a memory bomb) and confirm the
  failure mode — does it hang forever, OOM, or hit an internal limit?
- Measure whether a wedged compile takes down the whole pool or only one thread.
- Prototype a killable child-process compile and measure its overhead versus in-process.

**Exit:** a documented, honest answer. If the overhead is acceptable, a process pool becomes a
Phase 3+ deliverable. If not, "trusted templates only" goes in the README prominently.

## Q2 — What does memory actually do over a long run?

**Why it matters:** validates the eviction-on-by-default decision and sizes the risk from the
`FileId` interner.

**To do:**
- Run 100k distinct compiles, sampling RSS. With `evict(2)`, with `evict(N)` for larger N, and
  with no eviction.
- Confirm RSS plateaus with eviction on.
- Separately: intern 65,535 distinct paths and confirm the panic message and behavior, so the
  guard rail in Phase 1 can fail earlier with a better error.

**Exit:** an RSS-over-time curve, and a concrete threshold at which our own `FileId` guard
should trip.

## Q3 — How does throughput scale with pool size?

**Why it matters:** settles the concurrency model before the API depends on it.

**To do:**
- Sweep pool size from 1 to 2× cores, measuring docs/sec.
- Determine whether typst's internal rayon usage oversubscribes on top of our pool, and
  whether bounding or disabling it helps.
- Measure `comemo` cache lock contention across threads — the cache is global and behind an
  `RwLock`, so it may become a bottleneck at high thread counts.

**Exit:** a recommended default pool size, and evidence on whether cache contention limits
scaling.

## Q4 — What does `tagged: true` actually cost?

**Why it matters:** it defaults to `true` and affects every benchmark number we publish.

**To do:** measure compile time and output size with `tagged` on versus off, on a realistic
document.

**Exit:** a number to document. Keep the upstream default; give users an informed choice.

## Q5 — Does `psm`/`stacker` build on the exotic targets?

**Why it matters:** it is the only per-architecture assembly dependency and the most likely
thing to break the target matrix. Discovering this in Phase 4 would invalidate release work.

**To do:** cross-compile a trivial binary depending on `typst-eval` for every target in
[`../discovery/06-distribution.md`](../discovery/06-distribution.md), especially
`linux-arm-gnueabihf`, `freebsd-x64`, `android-*`, `win32-ia32-msvc`, and
`wasm32-wasip1-threads`.

**Exit:** a confirmed target list. Any target that fails gets dropped now, not after CI is built.

## Also worth confirming

- **Stack depth on wasm.** `stacker` cannot grow the stack on wasm; find the practical nesting
  limit so the fallback's limitations can be documented concretely.
- **SVG text without registered fonts** — confirm glyphs silently drop, so Phase 1 can emit a
  real diagnostic for it.

## Deliverables

1. A short findings document appended to `../discovery/` (or amending
   [`07-benchmarks.md`](../discovery/07-benchmarks.md)).
2. The benchmark harness promoted to `crates/emquad-engine/benches/`.
3. A go/no-go on each architectural decision in
   [`00-overview.md`](00-overview.md#decisions-already-made).
