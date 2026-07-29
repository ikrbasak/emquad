# Architecture

Three files, and each exists to solve one problem the JS boundary creates.

| File | Problem it solves |
|---|---|
| `pool.rs` | Typst compilation is synchronous and CPU-bound; Node's event loop must not block |
| `convert.rs` | JS values are not `Send` and cannot cross to a worker thread |
| `lib.rs` | The two above have to be wired together without letting a panic escape |

## Why a dedicated pool rather than `AsyncTask`

napi's `AsyncTask` would be a fraction of the code and is the wrong tool. It runs on the libuv
threadpool, which:

- defaults to **4** threads (`UV_THREADPOOL_SIZE`), so a server would silently cap at four
  concurrent renders;
- is **shared with `fs`, DNS, `crypto`, and zlib**, so PDF load would stall unrelated file
  reads with no symptom pointing at this library;
- is tunable only by an environment variable that must be set *before any I/O happens*;
- offers no backpressure — the queue is an opaque FIFO.

Handing users that failure mode by default is not acceptable, so: our threads, our bounded
queue, our backpressure.

## The pool

```
compile(request)                      [JS thread]
   │
   ├─ prepare(request)                convert JS values to owned data
   ├─ pool.has_room()?  ──no──▶       throw QUEUE_FULL
   ├─ env.create_deferred()           the Promise handed back to JS
   ├─ pool.submit(job)
   ▼
 queue ──▶ worker thread
              ├─ run(inner, prepared)     catch_unwind around the whole thing
              ├─ deferred.resolve(result) settles the Promise on the JS thread
              └─ cache::evict(max_age)    the pool owns eviction
```

### Backpressure refuses rather than blocks

An unbounded queue converts sustained overload into an out-of-memory crash. Blocking the
submitting thread would block Node's event loop — the one thing an async API exists to avoid.
So a full queue is refused immediately and the caller decides: shed load, retry, or raise
`queueCapacity`.

### `has_room()` before `create_deferred()`, and why that ordering is load-bearing

The first version created the deferred and then submitted, returning an error if submission was
refused. That **hung Node**: a `JsDeferred` holds a threadsafe function, and a deferred that is
never settled never releases it, so the event loop stays alive forever. The whole test suite
hung with no output.

Checking capacity first fixes it, and the check is sound rather than racy: `compile()` only ever
runs on the JS thread, and workers only ever *remove* jobs, so the queue cannot shrink between
the check and the submission in a way that matters.

**The invariant to preserve: never create a deferred you might not settle.**

### The pool owns eviction

`comemo`'s cache is process-global, so no individual `Compiler` can evict correctly — two
compilers share one cache. Each worker evicts after finishing a job, which is exactly the
configuration Phase 0 measured (~40 MB against ~1 GB over 100k compiles, for 5.9% throughput at
`max_age = 16`).

`compileSync()` never touches the pool, so it never evicts. That is why `evictCache()` is
exported: a sync-only caller would otherwise grow the cache without bound.

### Panics cost one compile

Three layers, because a panic reaching Node aborts the process outright:

1. The engine wraps `typst::compile` in `catch_unwind`.
2. `run()` wraps request assembly *and* the engine call, so a panic anywhere becomes a
   `PANIC` result.
3. The worker wraps the whole job, as a backstop for a panic in the settling code itself.

Layer 3 matters more than it looks: without it a panicking job would kill the worker thread and
the pool would silently shrink. There is a Rust test for exactly that
(`a_panicking_job_does_not_take_down_its_worker`), and a Node test proving the process survives
(`__panicInPool`, compiled only under the `test-hooks` feature).

## `convert.rs` — everything happens on the JS thread

This is not stylistic. `Uint8Array` borrows V8-owned memory and is not `Send`, so a request has
to be copied into owned data before a worker can touch it. Doing the whole conversion up front
has a second benefit: argument errors surface **synchronously**, before a queue slot is spent.

`OwnedData` is the boundary type — `Text(String)` or `Bytes(Vec<u8>)`, both `Send`.

### `string | Buffer | Uint8Array`

Modelled as `Either<String, Uint8Array>`. `Buffer` needs no third arm: it *is* a `Uint8Array`,
and napi's typed-array check accepts it.

### Zero-copy output

`Buffer::from(Vec<u8>)` hands ownership to V8 without copying. A multi-megabyte PDF is exactly
the thing not to copy needlessly. A Node test asserts the trailer is present in the last 32
bytes, which proves the whole buffer crossed rather than a truncated view of it.

### PDF standards are parsed by hand

Spelled out as a match rather than derived from typst's serde names, because this crate does not
depend on serde and because an unknown name should fail with a list of what is accepted rather
than a deserialization error.

## A subtle bug worth remembering

`panic_message` originally took `&(dyn Any + Send)` and was called as `panic_message(&payload)`
where `payload: Box<dyn Any + Send>`. Every downcast failed, and a plain `panic!("...")`
reported "panic with a non-string payload".

The reason: **`Box<dyn Any + Send>` is itself `Any`**, so `&payload` coerces to a `&dyn Any`
whose erased type is the *box*, not its contents. The fix is `&*payload`. The engine's version
never had the bug because it takes the `Box` by value, where method resolution auto-derefs.

## Errors: two kinds, two mechanisms

| Kind | Mechanism | Examples |
|---|---|---|
| Outcome | returned in `CompileResult` | compile failed, no fonts, path guard tripped, panic |
| Usage | thrown | unknown PDF standard, queue full, empty font set at construction |

The split is deliberate. Outcomes carry structured diagnostics that a `napi::Error` cannot hold,
and they behave identically on the sync and async paths. Usage errors are programming mistakes
and should interrupt control flow.

`code()` is a stable string — `COMPILE_FAILED`, `NO_FONTS`, `PATH_VOCABULARY_EXHAUSTED`,
`INVALID_PDF_SETTINGS`, `MAIN_NOT_FOUND`, `PANIC`. Thrown errors carry the same code in square
brackets at the front of the message, so Phase 3 can recover it uniformly.

## What is deliberately absent

- **No `timeout` option.** Typst has no cancellation hook and a Rust thread cannot be forcibly
  killed. A timeout would leak a wedged worker while looking like protection; an API that
  appears to protect you but does not is worse than an honest absence. Untrusted templates need
  process isolation.
- **No automatic eviction on the sync path.** The caller owns it, because the library cannot
  know their batch boundaries.
- **No convenience for per-request VFS paths.** They are interned process-wide and never freed.
  The engine guards at 50,000, but an API that invites the mistake is still a bad API.
