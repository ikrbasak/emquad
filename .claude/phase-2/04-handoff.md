# Handoff to Phase 3

Written for someone — human or agent — who has not seen the earlier work.

## Where things stand

Phases 0, 1, and 2 are complete. Phase 3 (`@emquad/core` and `@emquad/resolver`, TypeScript) has
not started. The brief is
[`../plan/04-phase-3-typescript.md`](../plan/04-phase-3-typescript.md).

| Layer | State |
|---|---|
| `crates/emquad-engine` | Done. VFS → PDF, 64 Rust tests. [`../phase-1/`](../phase-1/00-overview.md) |
| `crates/emquad-napi` | Done. Pool, JS boundary, 32 Node tests. [`00-overview.md`](00-overview.md) |
| `packages/binding` | Internal, private. Generated `index.js` + `index.d.ts` |
| `@emquad/core` | **Not started.** Phase 3 |
| `@emquad/resolver` | **Not started.** Phase 3, and independent of everything else |
| `@emquad/fonts` | **Not started.** Read [`../../LICENSING.md`](../../LICENSING.md) first |

## Phase 3's four jobs

### 1. The public API, over `@emquad/binding`

Fluent, fully typed, ESM-only. The binding's surface is deliberately low-level; `@emquad/core`
is what users import.

### 2. Turn the result into a thrown `Error` subclass

The binding **returns** compile failures rather than throwing, because a promise rejection can
only carry a message and a status. Phase 3 owns the conversion:

```ts
const result = await binding.compile(request);
if (!result.ok) throw new EmquadError(result.error);   // code, diagnostics, positions, hints
return result;
```

`EmquadError` should carry `code`, `diagnostics`, and convenience accessors for the first
diagnostic's `file`/`line`/`column`. Users need to branch programmatically, so **never** collapse
these into a formatted string.

Thrown binding errors (usage mistakes) carry their code in square brackets at the front of the
message — `[QUEUE_FULL] ...` — so they can be normalized the same way.

### 3. The worker-process pool ⚠ moved here from Phase 2

**This is the highest-value item in the plan, and Phase 2 strengthened the case for it.**

It could not be built in Rust: process isolation needs a separate OS process running the addon,
and we ship a `.node` addon rather than an executable, so the child must be a Node process
spawned and supervised by Node. `child_process` already exists there.

Two independent justifications, one mechanism:

- **Throughput.** Documents with many page runs *collapse* under an in-process thread pool —
  0.45× at eight threads — while separate processes scale to 5.18×. Phase 2 eliminated the
  leading hypothesis for that collapse: pinning typst's rayon to one thread does not help. The
  contention is process-global, most likely `comemo`'s cache.
- **Runaway templates.** Typst has no cancellation hook and Rust threads cannot be killed. A
  wedged compile costs one worker; killing a worker process takes 22–35 ms. This is the *only*
  answer for untrusted templates.

Constraints from Phase 0, all measured:

- **Workers must be reused.** Process-per-compile is 11.2× slower (877 µs → 9,819 µs).
- Each worker holds its own `Compiler`, so fonts and the base VFS are parsed once *per process*.
  Sending them to every worker at startup is the expensive part — measure it.
- Use `compileSync()` inside a worker. It is faster there, and the pool is the wrong layer to
  add a second hop.

### 4. The resolver

Independent of all the Rust work and can proceed in parallel from day one. Two things Phase 2
learned that constrain it:

- **Mount `typst.toml`.** Typst reads it to find the entrypoint; without it the import fails
  with a file-not-found error naming a file the user never asked for. Whatever the resolver
  caches must include the manifest, not only the `.typ` files.
- **Networking lives here, in TypeScript.** That is what keeps the Rust tree free of `-sys`
  crates and the 14-target matrix affordable (hard rule 4). Do not move it into Rust.

## Things not to break

- **Never create a `JsDeferred` you might not settle.** It holds a threadsafe function that
  keeps Node's event loop alive forever. One unsettled deferred made the whole test suite hang
  with no output. If Phase 3 adds Rust surface, `pool.has_room()` before `create_deferred()` is
  the pattern.
- **Never let a panic reach Node.** It aborts the process. Three layers of `catch_unwind` cover
  the current paths; a new entry point needs its own.
- **No `timeout` option.** It cannot work, and an option that looks like protection is worse
  than none. Process isolation is the answer, and it is now Phase 3's to build.
- **`pinRayon` stays `false`.** It was measured, not assumed. If you revisit it, use
  `bench/poolcmp.sh` — one configuration per process.
- **`tagged: true` stays the PDF default.** The cost is size (up to +302%), not time.
- **Zero `-sys` crates** except `napi-sys` and `windows-sys`, both bindings-only.
  `scripts/check-no-sys-crates.sh` enforces it on every commit.

## Testing

[`../plan/07-testing-strategy.md`](../plan/07-testing-strategy.md) is the plan. The
load-bearing principle: **PDF generation fails silently far more often than it crashes.**

Covered so far: VFS layering, the interner guard, fonts, exact line/column mapping, hints and
traces, determinism under concurrency, reproducibility, PDF settings validation, backpressure,
panic containment, and zero-copy output.

Phase 3 must add:

- **Golden-file rendering comparisons.** Still not done, and still the primary defense against
  silent-wrong-output. Neither Rust layer can do it — comparing rendered pages needs a
  rasterizer, and this project exports PDF only. Do it from Node: assert on rendered page images
  with a perceptual threshold plus extracted text and page count. **Do not snapshot raw PDF
  bytes** — they shift with every typst release and produce unreviewable diffs.
- **Resolver tests** with a fully mocked registry. The core correctness claim is that the
  network is hit **exactly once per version, never per compile** — assert it.
- **Clean-consumer ESM smoke test**: a fresh `"type": "module"` project installs the packed
  tarball and runs `import { Compiler } from '@emquad/core'`. Catches loader and `exports`-map
  regressions nothing else does.
- **The soak test as a nightly**, asserting RSS plateaus with eviction on.

## Two open questions carried forward

1. **Throughput is 23% below Phase 0's figure** and unexplained — 652 µs against 532 µs on the
   engine benchmark, while the *memoized* row is faster than Phase 0's. See
   [`../phase-1/03-findings.md`](../phase-1/03-findings.md#throughput-an-unresolved-discrepancy).
   **No throughput number should be published until this is resolved.**
2. **Why our rayon pinning behaves differently from `RAYON_NUM_THREADS=1`.** Phase 0 measured
   +43% with the environment variable; Phase 2 measured no benefit with a per-thread pool. Worth
   one sweep with the variable set externally to tell which measurement was the artifact. See
   [`03-findings.md`](03-findings.md#what-is-still-unexplained).

## Distribution, for Phase 4

- All 14 targets verified in Phase 0, but the three `win32-*-msvc` targets **cannot be
  cross-compiled** — `stacker` compiles `windows.c` and `psm` needs `lib.exe`. Native runners
  required. `spike/xtarget/sweep2.sh` has the working environment for the other eleven.
- `napi build --platform --esm` is wired up in `packages/binding/package.json`, with the target
  list already in its `napi.targets`.
- Node floor is **22**, and the binding is built against Node-API 9.
