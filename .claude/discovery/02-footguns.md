# Footguns

Three process-global behaviors in Typst are safe for a CLI that renders once and exits, and
actively dangerous for a long-running server. Our entire use case is the long-running server.

**These are the highest-value findings of the investigation. Design for them up front.**

---

## 1. `FileId` is a leaky, capped, process-global interner

**Severity: crash in production.**

From `typst-syntax-0.15.1/src/path.rs:115`:

```rust
// Create a new entry forever by leaking the pair. We can't leak more
// than 2^16 pair (and typically will leak a lot less), so its not a
// big deal.
let num = u16::try_from(interner.from_id.len() + 1)
    .and_then(NonZeroU16::try_from)
    .expect("out of file ids");

let id = FileId(num);
let leaked = Box::leak(Box::new(path));
```

Facts:

- `FileId` is a `NonZeroU16` → **hard cap of 65,535 distinct paths per process**.
- Every interned path is `Box::leak`'d → **never freed**, for the life of the process.
- The interner is a global `static INTERNER: LazyLock<RwLock<Interner>>`.
- Exceeding the cap **panics**. A panic crossing the FFI boundary takes down the Node process.

The upstream comment's assumption ("not a big deal") is correct for `typst-cli`. It is wrong
for us.

### Failure scenario

A server whose VFS API lets callers name files per request:

```ts
// DO NOT design an API that allows this
doc.source(`invoice-${uuid}.typ`, tpl);
doc.asset(`tenant/${tenantId}/logo.png`, buf);
```

Memory grows monotonically, and at ~65k renders the process hard-crashes. This surfaces days
after launch and is extremely difficult to trace back to a filename.

### Design rules

1. **Canonical paths only.** Content varies per render; paths never do. Always `main.typ`,
   `assets/logo.png`.
2. **Do not expose arbitrary per-render filenames** in the public TS API. Make the safe thing
   the only ergonomic thing.
3. **Instrument the count.** Track interned paths and fail with a clear, actionable error well
   before 65,535 rather than letting `expect` panic.
4. Mounted `@preview` packages are a bounded set — those are fine.

There is also `FileId::new_fake(...)` for "virtual" ids not accessible by path. It does **not**
deduplicate (each call is unique), so it makes the leak *worse*, not better. Do not reach for
it as a workaround.

### Measured in Phase 0

- The cap is exactly **65,535**. The 65,535th path interns fine; the 65,536th panics with
  `out of file ids: TryFromIntError(PosOverflow)`.
- **`catch_unwind` does contain this panic** — the process survives. The mitigation in hard
  rule 2 is verified, not just assumed.
- Each leaked path costs **~211 bytes** (13.5 MB at 65k), so memory is not the concern here.
  The crash is.

Trip our own guard around **50,000**, with a message naming the offending path pattern.

---

## 2. `comemo`'s memo cache is process-global and unbounded

**Severity: steady memory growth.**

From `comemo/src/memoize.rs`:

```rust
static EVICTORS: RwLock<Vec<fn(usize)>> = RwLock::new(Vec::new());

/// ...The age of a result grows by one during each eviction
/// and is reset to zero when the result produces a cache hit.
pub fn evict(max_age: usize) { ... }
```

- The cache is **process-global**, not per-`World` and not thread-local.
- It grows without bound until `comemo::evict(max_age)` is called.
- Eviction is **age-based**: age increments on each eviction pass, resets to zero on a cache hit.

### Implications

- **Upside:** concurrent compiles share the cache, so parsed packages and font data get reused
  across renders. This is real throughput value.
- **Downside:** eviction is a *process-wide* concern, not something an individual `Compiler`
  instance can own correctly. Whoever owns the thread pool must own the eviction policy.
- Two `Compiler` instances in one process are **not** isolated from each other cache-wise.

### Design rules

1. The thread pool owns eviction; call `evict()` on a policy (every N compiles, or on a timer).
2. Expose `cache.maxAge` as a documented knob.
3. Document that the cache is process-global so users are not surprised when two `Compiler`
   instances interact.
4. Benchmark both with and without eviction — it is a real throughput/memory tradeoff
   (see [07-benchmarks.md](07-benchmarks.md)).

---

## 3. There is no cancellation or timeout API

**Severity: no in-process mitigation available.**

Searching `typst-0.15.1` and `typst-library-0.15.1` for `cancel`, `deadline`, `timeout`,
`should_stop`, or `interrupt` returns **nothing**. `typst::compile` runs to completion.

### What typst *does* guard (measured in Phase 0)

This section originally said only `MAX_DEPTH` exists. That understates it — three guards fire,
all returning clean diagnostics rather than hanging:

| Input | Guard | Time to error |
|---|---|---|
| `while true { ... }` | Static lint, "condition is always true" | immediate |
| `while n > 0 { ... }` | `MAX_ITERATIONS = 10_000` (`typst-eval/src/flow.rs:81`) | 353 ms |
| Infinite recursion, deep nesting | `MAX_DEPTH` | 110–351 ms |

### What remains unguarded

**`MAX_ITERATIONS` applies to `while` loops only. `for` loops have no iteration limit.**

- `for i in range(10000) { for j in range(10000) {...} }` — runs indefinitely at **flat memory**.
  Nothing detects it. This is the realistic wedge.
- `range()` materializes a real array, so `range(100000000)` allocates ~1.6 GB by itself.
- A memory bomb reaches **2.4 GB in 0.47 s**.

Typst evaluates ~4M loop iterations/sec, so a wedging document need not be exotic.

**Blast radius is one thread, not the pool** — with one worker wedged, 600 documents completed
across three healthy workers in 505 ms. The wedged thread never returns and is never reclaimed.

See [08-phase-0-results.md](08-phase-0-results.md#q1--runaway-compiles) for the full matrix.

### Implications

- You cannot kill a runaway compile from JavaScript. The pool thread is stuck permanently.
- Threads cannot be forcibly killed in Rust, so a thread pool offers **no** protection.
- **For untrusted templates, thread isolation is insufficient — you need process isolation.**

### Design rules

1. Document clearly: templates are trusted input.
2. For untrusted templates, the supported pattern is a **worker process** that can be killed,
   not a worker thread.
3. Do not pretend a timeout option on the thread-pool API is real safety. An API that *looks*
   like it can time out but silently leaks a wedged thread is worse than no option at all.
4. **Ship the worker-process pool.** Phase 0 promoted this from "consider later" to a real
   deliverable — Q3 independently found processes scale 7× better than threads on some document
   shapes, so one mechanism serves both needs. Supervision is cheap: killing a runaway child
   took 22–35 ms and reclaimed all memory. It must be a *reusable* worker; a fresh process per
   compile measured **11.2× slower**.

---

## Lesser gotchas

### `PdfOptions.tagged` defaults to `true`

Verified at `typst-pdf-0.15.1/src/lib.rs:107`. This enables PDF/UA accessibility tagging,
which costs time and output size.

Measured in Phase 0: time is a minor cost (+5% on an invoice, +28% on a content-heavy report),
but **output size grows up to 4×** (65.7 KB → 264.0 KB). At millions of documents that is a
storage and bandwidth line item, not a rounding error.

Expose it as an explicit option. **Do not silently default it to `false` for benchmark
numbers** — that is an accessibility regression users will not notice, and some need it for
compliance. Let them opt out knowingly.

### Reproducible output needs three things pinned

`World::today()`, `PdfOptions::ident`, and `PdfOptions::timestamp` all inject nondeterminism.
Byte-identical output requires pinning all three. Cheap to design in now; annoying to retrofit
once people depend on hashes.

### `font()` may receive out-of-bounds indices

Documented upstream behavior during incremental compilation. Return `None`; never index
directly or panic.

### Panics must not cross the FFI boundary

Any Rust panic reaching Node aborts the process. Wrap compile entry points in
`catch_unwind` and convert to JS errors. This matters more than usual given footgun #1.
