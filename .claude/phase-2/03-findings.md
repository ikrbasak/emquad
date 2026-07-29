# Phase 2 findings

One result that **retracts a hard rule**, and three bugs worth remembering because each was
invisible until something specific was measured.

---

## 1. Hard rule 9 is retracted: rayon pinning does not help ⚠

**Supersedes hard rule 9, [`../discovery/03-concurrency.md`](../discovery/03-concurrency.md),
and [`../phase-1/03-findings.md#1`](../phase-1/03-findings.md).**

Phase 0 measured `RAYON_NUM_THREADS=1` as worth **29–43%** on documents with many page runs, and
recorded it as a hard rule. Phase 1 measured our in-process equivalent single-threaded and found
it *cost* 12%, but left the decision open because the claimed benefit only appears under a
saturated pool — which Phase 1 had no way to create.

Phase 2 has that pool. The benefit does not appear.

### Measured

`packages/binding/bench/poolcmp.sh`, release build, **one configuration per process**, order
alternated across repetitions, three repetitions on multirun and two on invoice. Throughput in
docs/s on an Apple M1:

| Threads | multirun, pinned | multirun, unpinned | invoice, pinned | invoice, unpinned |
|---|---|---|---|---|
| 1 | 252 | **296** | 1,313 | 1,370 |
| 2 | 216 | 230 | 2,615 | 2,632 |
| 4 | **218** | 203 | 4,031 | 4,561 |
| 8 | 113 | 114 | 4,456 | 5,310 |

### Two conclusions, the second far more important

**Pinning has no consistent direction.** It costs ~15% at one thread, wins ~5% at four, and ties
at eight. On ordinary documents it does nothing at any size. A knob that cannot be shown to help
should not be on by default, so **`pinRayon` now defaults to `false`** in both the engine and
the binding.

**Rayon is not what makes multi-run documents collapse.** This is the real finding. With typst
confined to a single rayon thread per worker — verified directly by
`typst_sees_a_single_rayon_thread` — throughput *still* falls to **0.45×** at eight threads.
Nested parallelism was the leading hypothesis for that collapse, and it is now eliminated.

What remains is process-global contention. Phase 0 named the likeliest culprit, `comemo`'s
global cache, and showed that separate *processes* scale to 5.18× on the same document where
threads reach 0.46×.

**So the fix is process isolation, not rayon tuning.** That makes the worker-process pool the
single highest-value item left in the plan, and this measurement is the strongest argument for
it. See [`04-handoff.md`](04-handoff.md).

### What is still unexplained

Phase 0's +43% used `RAYON_NUM_THREADS=1`, which shrinks the *global* pool that every worker
injects into. This crate pins differently: a private one-thread pool per worker, running inline
via `use_current_thread()`. The two mechanisms should behave nearly identically, and they do
not. That gap is why the knob still exists rather than being deleted.

A worthwhile experiment for whoever profiles the collapse: run the same sweep with
`RAYON_NUM_THREADS=1` set externally and see whether Phase 0's number reappears. If it does, the
difference is in the pinning mechanism; if it does not, Phase 0's result was itself an artifact.

---

## 2. An unsettled `JsDeferred` hangs Node forever ⚠

The first version of `compile()` created the deferred, then submitted to the pool, and returned
an error if the queue was full. The Node test suite hung with **no output at all** — not a
failure, not a timeout, just a process that never exited.

`JsDeferred` holds a threadsafe function, and a threadsafe function keeps Node's event loop
alive until it is released. A deferred dropped without `resolve` or `reject` never releases it.
One refused submission is enough to make the process immortal.

**The invariant: never create a deferred you might not settle.** `compile()` now checks
`pool.has_room()` *before* creating one. The check is sound rather than racy because `compile()`
only runs on the JS thread and workers only remove jobs.

This is the kind of bug that would have shipped: it does not fail, it hangs, and only under
backpressure.

---

## 3. `&Box<dyn Any>` erases the box, not its contents

`panic_message` took `&(dyn Any + Send)` and was called as `panic_message(&payload)` where
`payload: Box<dyn Any + Send>`. Every downcast failed, so a plain `panic!("deliberate panic")`
reported `panic with a non-string payload`.

`Box<dyn Any + Send>` implements `Any` itself, so `&payload` coerces to a `&dyn Any` whose
erased type is the **box**. The fix is `&*payload`.

The engine's copy never had the bug because it takes the `Box` by value, where method resolution
auto-derefs. Only the caught panic's *message* was wrong — containment worked throughout — but
a wrong message on a panic is exactly the wrong time to have one.

---

## 4. `napi-sys` is the one allowed exception to hard rule 4

`napi` depends on `napi-sys`, which `scripts/check-no-sys-crates.sh` would otherwise reject.
It is allowed by name, alongside `windows-sys`, because it declares extern N-API symbols
resolved against the host Node binary at load time: no C library, no bindgen, no cmake, and
nothing that costs us the cross-compile matrix.

Default features stay on for `dyn-symbols`, which resolves Node's symbols at runtime rather than
linking against a `.lib`. That matters for Windows, where the alternative needs the Node headers
present at build time — and Windows is already the constrained corner of the target matrix.

The tree is otherwise unchanged: still zero other `-sys` crates, still every license permissive.

---

## Notes for anyone benchmarking this

- **Build release.** An unoptimized typst is roughly two orders of magnitude slower.
  `[profile.dev.package."*"] opt-level = 3` keeps *dependencies* optimized in debug builds,
  which is what makes the Node test suite finish in about a second instead of many minutes.
- **One configuration per process.** `comemo` is process-global, and disjoint document
  *indices* are not disjoint *work* — two invoices differing by a substituted number share
  nearly all their layout. This has produced two confidently wrong numbers in this project
  already (Phase 0's `tagged` at +139% against a true +5%; Phase 1's first rayon comparison at
  20% against a true 0%).
- **Alternate the order** across repetitions, so a thermal ramp or a warm page cache cannot
  masquerade as a result.

---

## Confirmations

- **Sync and async produce byte-identical output** for the same request.
- **Parallel compiles match serial ones byte for byte** across 16 requests on a 4-thread pool,
  despite `comemo`, the `FileId` interner, and the font book all being process-global.
- **A panic surfaces as a value**, and the pool keeps working afterwards — proven from JS, not
  asserted.
- **The path guard reaches JS intact**, naming the offending pattern (`/leak-*-*.typ`) and what
  to do instead.
- **Zero-copy output is complete**: the PDF trailer is present in the last 32 bytes of the
  Buffer.
