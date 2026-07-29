# Concurrency Model

Typst compilation is **synchronous and CPU-bound**. `typst::compile` runs to completion with
no yield points and no cancellation hook. The question is how to schedule it relative to
Node's event loop.

## Options compared

|  | **Dedicated Rust pool** | **libuv threadpool** (napi `AsyncTask`) | **Sync only** |
|---|---|---|---|
| Code required | Pool + Promise bridge — most | Least; napi-rs handles it | Least of all |
| Default parallelism | Physical cores, we choose | **4** (`UV_THREADPOOL_SIZE`), cap 1024 | Caller's |
| Blocks event loop | No | No | **Yes** |
| Contention | Isolated | **Shares pool with `fs`, DNS, `crypto`, zlib** | N/A |
| Backpressure | Own bounded queue, can prioritize | None — opaque libuv FIFO | Caller's problem |
| Tuning | Our API, discoverable | Env var, must be set *before* any I/O | Caller builds pool |
| Nested parallelism | We control oversubscription | Typst's rayon nests inside a libuv thread | Fine |

## Decision: dedicated Rust pool, **plus** a `compileSync()` escape hatch

The libuv contention row decides it. `UV_THREADPOOL_SIZE` defaults to **4** and is shared with
`fs`, DNS, and `crypto`. A server under PDF load would silently cap at 4 concurrent renders
*and* stall unrelated file reads — with no symptom pointing at our library. Handing users that
failure mode by default is not acceptable.

Shipping sync as well is not hedging; the two serve genuinely different workloads:

- **Async + dedicated pool** — request-serving web servers. The default.
- **`compileSync()`** — batch jobs and worker threads. For the Zerodha-style workload (N
  processes each looping over documents), async scheduling is pure overhead and sync is
  *faster*. It is also the correct call inside an existing `worker_thread`.

## Design requirements

### The pool owns cache eviction

Because `comemo`'s cache is process-global (see [02-footguns.md](02-footguns.md)), no
individual `Compiler` instance can own eviction correctly. The pool must.

[Benchmarks](07-benchmarks.md) show `evict(2)` on every compile costs only **~9%** throughput.
That is cheap enough that **bounded memory should be the default**, with tuning available for
users who want the last 9%.

### Snapshot isolation

`World` is `Send + Sync`. Each compile gets an immutable `Arc` snapshot of the base VFS layer
plus its own overlay, so concurrent compiles cannot observe a torn state. This is where
correctness bugs would hide — test it under concurrent load explicitly.

### Nested parallelism — measured, pin rayon to 1 thread

`typst-layout` parallelizes **page runs** across the global rayon pool
(`typst-layout-0.15.1/src/pages/mod.rs:185`). Because it iterates page-configuration
boundaries rather than pages, ordinary documents have exactly one item and rayon never engages.

On documents with many page runs it does engage, and it **costs 29–43%**. Pinning rayon to a
single thread is faster in every configuration measured, including at pool size 1. Do it by
building the global pool in-process, not via `RAYON_NUM_THREADS` — that variable would also
degrade a host application's own rayon usage. See
[08-phase-0-results.md](08-phase-0-results.md#q3--throughput-vs-pool-size-).

### Panics must not cross the FFI boundary

A Rust panic reaching Node aborts the whole process. Wrap compile entry points in
`catch_unwind` and convert to JS errors. This is doubly important given the `FileId`
interner's `expect("out of file ids")`.

### No fake timeouts

There is no cancellation API in Typst, and Rust threads cannot be forcibly killed. A `timeout`
option on the thread-pool API would silently leak a wedged thread while appearing to work —
worse than not offering one. For untrusted templates the answer is **process** isolation, and
that should be documented rather than papered over.

## Measured in Phase 0 — and it revises this decision

Full results: [08-phase-0-results.md](08-phase-0-results.md#q3--throughput-vs-pool-size-).

The dedicated thread pool above remains the right default, but it is **not sufficient on its
own**, because thread scaling depends on document shape:

| Document shape | Threads | Processes |
|---|---|---|
| Single-page invoice | scales to 3.71× at 4 threads, then flat | same plateau (4.12×) — hardware, not contention |
| 40 page runs | peaks at 2 threads, then falls to **0.46×** | scales monotonically to **5.18×** |

For the second shape, processes are **7× faster than threads at 16-way**. The only difference is
process-global shared state, with `comemo`'s cache the prime suspect.

Two consequences:

1. A **persistent worker-process pool** moves from "maybe later" to a real deliverable. Q1
   reached the same conclusion independently for untrusted templates — one mechanism serves both.
   It must be a *reusable* worker, not a process per compile, which measured 11.2× slower.
2. Pool size cannot be chosen correctly for all workloads. Default to `available_parallelism()`,
   expose the knob, and document that scaling is document-shape dependent.

Profile the contention properly in Phase 2 before finalizing defaults.
