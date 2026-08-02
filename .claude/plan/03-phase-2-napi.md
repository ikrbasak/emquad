# Phase 2 — napi Binding Layer (`emquad-napi`)

> ## ✅ Complete
>
> Built and documented in [`../phase-2/`](../phase-2/00-overview.md). 64 Rust tests and 32 Node
> tests pass.
>
> **Two deviations.** A failed compile is *returned* rather than thrown, because a promise
> rejection cannot carry structured diagnostics — Phase 3 turns it into the `Error` subclass.
> And the **worker-process pool moved to Phase 3**: process isolation needs Node to spawn the
> process, and we ship an addon rather than an executable.
>
> **Hard rule 9 is retracted here.** Pinning typst's rayon buys nothing under a real pool, which
> means the multi-run collapse is process-global contention — see
> [`../phase-2/03-findings.md`](../phase-2/03-findings.md).
>
> The document below is the original brief, kept for context. Proceed to
> [Phase 3](04-phase-3-typescript.md), starting with
> [`../phase-2/04-handoff.md`](../phase-2/04-handoff.md).

A **thin** layer. All logic belongs in `emquad-engine`; this crate handles the JS boundary,
threading, and cache lifecycle only.

## 2.1 Thread pool

Dedicated Rust pool, **not** the libuv threadpool. Rationale and comparison table in
[`../discovery/03-concurrency.md`](../discovery/03-concurrency.md) — the short version is that
`UV_THREADPOOL_SIZE` defaults to 4 and is shared with `fs`, DNS, and `crypto`, so using it
would silently cap throughput and stall unrelated I/O.

- Default size from Phase 0 Q3 measurements, not assumed to be `cores`.
- Bounded queue with real backpressure; reject or queue explicitly rather than growing without limit.
- Configurable at `Compiler` construction.
- Expose both `compile()` (async, Promise) and `compileSync()`.

`compileSync()` is not a hedge — for batch workloads (N processes each looping), async
scheduling is pure overhead, and sync is both faster and correct inside an existing
`worker_thread`.

## 2.2 Cache eviction

The pool owns eviction, because `comemo`'s cache is process-global and no individual
`Compiler` can own it correctly.

- **Default: on.** Measured at ~9% throughput cost, which is cheap for bounded memory.
- Configurable: `cache: { maxAge: number | false }`.
- Document clearly that the cache is process-global, so two `Compiler` instances are not
  isolated from each other.

## 2.3 JS boundary

- **Zero-copy** `Vec<u8>` → `Buffer` for PDF output; do not copy a multi-MB buffer needlessly.
- VFS accepts `string | Buffer | Uint8Array`; strings are UTF-8 encoded, buffers stored as-is.
  Binary assets are required for the image support in
  [`../discovery/05-fonts-assets-charts.md`](../discovery/05-fonts-assets-charts.md).
- Diagnostics map to a real `Error` subclass carrying `file`, `line`, `column`, `hints`, and
  `severity` as structured fields — not a formatted string. Users need to handle these
  programmatically.
- **`catch_unwind` at every entry point.** A Rust panic reaching Node aborts the process, and
  the `FileId` interner's `expect("out of file ids")` makes this a live risk.

## 2.4 Explicitly not implemented

**No `timeout` option.** Typst has no cancellation API and Rust threads cannot be forcibly
killed, so a timeout option would silently leak a wedged pool thread while appearing to work.
An API that looks like it protects you but does not is worse than an honest absence.

Phase 0 Q1 answered this: process isolation *is* cheap enough, provided the workers are
**reused**. Process-per-compile is 11.2× slower (877 µs → 9,819 µs), but a wedged compile only
costs one worker and killing it takes 22–35 ms. Combined with the Q3 thread collapse, the
worker-process pool is now a deliverable rather than a maybe.

## Deliverables

- `Compiler` class with `compile()` / `compileSync()`
- Configurable pool and eviction policy
- ~~**Worker-process pool**~~ — **moved to Phase 3.** It needs Node to spawn and supervise the
  child, since we ship a `.node` addon rather than an executable. Still a deliverable, and Phase
  2's measurements made the case for it stronger
- Structured error type with source locations
- Zero-copy buffer output
- Concurrency tests: parallel compiles produce byte-identical output to serial ones
- ~~Promote `spike/phase0/src/bin/{runaway,pool,interner}.rs` and `procsweep.sh` into this
  phase's tests, then delete them.~~ **Done**, though not all in Phase 2: `interner.rs` became
  `__panicInPool` here, while `runaway.rs` and the process half of `pool.rs`/`procsweep.sh`
  needed the worker-process pool and so landed in Phase 3. `spike/` was deleted in Phase 4 —
  see [`../phase-4/00-publishing.md`](../phase-4/00-publishing.md#deleting-spike).
