# Handoff to Phase 2 — superseded

> **Phase 2 is complete.** If you are picking up the work now, read
> [`../phase-2/04-handoff.md`](../phase-2/04-handoff.md) instead.
>
> This document is kept because its footguns and constraints still apply, and because two of its
> open questions are still open. Note that **its rayon conclusion is superseded**: Phase 2
> measured pinning under a real pool and found no benefit, so hard rule 9 is retracted. See
> [`../phase-2/03-findings.md`](../phase-2/03-findings.md).

Written for someone — human or agent — who has not seen the earlier conversation.

## Where things stand

Phase 0 (spike) and Phase 1 (Rust core) are complete. The brief for what came next is
[`../plan/03-phase-2-napi.md`](../plan/03-phase-2-napi.md).

`emquad-engine` compiles a VFS to a PDF, has 61 passing tests, and is ready to be wrapped. It
has no napi dependency and should keep none — that separation is what lets the core be tested
with plain `cargo test` and reused from a wasm or CLI target later.

## Five things to internalize before writing code

1. **VFS paths are interned forever, capped at 65,535, and the interner panics when full.**
   Vary content, never paths. The engine guards at 50,000 and names the offending pattern, but
   the napi API must not make per-request paths *easy* — that would push users into the trap
   the guard only softens.

2. **A Rust panic reaching Node aborts the process.** The engine wraps its compile boundary in
   `catch_unwind`; every napi entry point needs the same. Never `panic = "abort"` — it disables
   `catch_unwind` entirely.

3. **There is no way to cancel a compile.** Typst has no cancellation hook and a Rust thread
   cannot be forcibly killed. Do not add a `timeout` option to the thread pool: it would leak a
   wedged thread while appearing to protect. Untrusted templates need process isolation, which
   is why the process pool exists.

4. **An empty font set produces a valid, blank PDF with zero diagnostics.** The engine rejects
   it at construction. Do not add a napi path that bypasses `Compiler::builder().build()`.

5. **`comemo` is process-global and unbounded.** Eviction is deliberately not automatic in the
   engine — the pool owns that policy, because the engine cannot know how many compiles are in
   flight. `cache::evict(cache::RECOMMENDED_MAX_AGE)` between compiles, never inside one.

## What Phase 2 has to build

From the plan, plus what Phase 0 and Phase 1 amended:

- **`Compiler` class with `compile()` and `compileSync()`.**
- **A worker-*process* pool.** Upgraded from "maybe" to a deliverable by Phase 0: threads
  collapse to **0.46×** on documents with many page runs where separate processes reach
  **5.18×**, and process isolation is also the only answer for runaway compiles. It must reuse
  workers — process-per-compile is 11.2× slower (877 µs → 9,819 µs). Kill latency is 22–35 ms.
- **Structured errors reaching JS.** `Error::code()` is already a stable string; map the
  variants onto a real `Error` subclass carrying `file`, `line`, `column`, `hints`, and
  `severity` as fields, not a formatted message.
- **Zero-copy buffer output** for `CompileOutput::pdf`.
- **Configurable eviction policy**, defaulting to `max_age = 16`.

## Two open questions Phase 2 must answer

### 1. Should `pin_rayon` stay on?

**This is the decision Phase 1 could not make.** Read
[`03-findings.md`](03-findings.md#1-hard-rule-9-is-not-never-worse-) in full.

The short version: hard rule 9 says pinning typst's rayon to one thread is "worth up to 43% and
never worse". Phase 1 measured that the second half is wrong — single-threaded, pinning costs
**12% on multi-run documents**. Phase 0's +43% was measured under a *saturated pool*, which is
exactly the regime Phase 2 creates and Phase 1 could not test.

The default is currently `true`, chosen because unpinned-under-load collapsing to 0.46× is far
worse than losing 12%. **Re-measure it under the real pool and set it deliberately.** The knob
is `Compiler::builder().pin_rayon(bool)`.

### 2. Why is throughput 23% below Phase 0's figure?

`cargo bench --bench compile` reports 652 µs against Phase 0's 532 µs, and it is unexplained.
**Resolved in Phase 5** — see [`../phase-5/00-throughput.md`](../phase-5/00-throughput.md).
Notably the *memoized* row is faster than Phase 0's, which argues against wrapper overhead.
Details and the candidate causes are in
[`03-findings.md`](03-findings.md#throughput-an-unresolved-discrepancy).

**No throughput number should be published until this is resolved.** The decisive experiment is
to rebuild `spike/phase0` and run it back to back against this engine on one machine. `spike/`
was deleted in Phase 4 — recover it from git history at `44c4eea` if this experiment is ever
run, since the point is to compare against the *original* harness.

## Benchmarking, before you measure anything

Two traps have each produced a confidently wrong number in this project already:

- **Benchmarks that never call `typst::compile` measure nothing** — LTO dead-strips the whole
  pipeline. One Phase 0 probe reported 376 KB for a full typesetting engine.
- **Single-process A/B comparisons are unreliable**, even with disjoint document indices,
  because `comemo` memoizes shared sub-document work. Phase 0's `tagged` result was +139%
  against a true +5%; Phase 1's first rayon comparison was 20% against a true 0%.

Use `scripts/benchcmp.sh` as the model: one configuration per process, repeated, alternating
order.

## Testing

[`../plan/07-testing-strategy.md`](../plan/07-testing-strategy.md) is the full plan. The
load-bearing principle: **PDF generation fails silently far more often than it crashes.** A
missing glyph or dropped text run yields a valid PDF that is simply wrong, and tests asserting
only "no error thrown" miss most real defects.

What Phase 1 covers (61 tests): VFS layering, the interning guard, the font registry, exact
line/column mapping, hints and traces, determinism under 16-way concurrency, reproducible
output, and PDF settings validation.

What Phase 2 must add:

- **Golden-file rendering comparisons.** Phase 1 cannot do these — comparing rendered pages
  needs a rasterizer, and this crate exports PDF only. Do it from Node. Assert on rendered page
  images with a perceptual threshold plus extracted text and page count; **do not snapshot raw
  PDF bytes**, which shift with every typst release and produce unreviewable diffs.
- **Panic containment, proven from JS.** Deliberately trigger a Rust panic and assert it
  surfaces as a catchable JS error rather than killing the process. Phase 1 could not test this
  end to end — the interner guard fires *before* typst's panic, by design, so the panic path is
  never reached through the public API. `spike/phase0/src/bin/interner.rs` is the probe that
  does reach it. **Done in Phase 2** — `__panicInPool` on the napi binding triggers a real
  panic on a pool thread, and `packages/binding/test/binding.test.js` asserts it surfaces as a
  catchable JS error.
- **Backpressure** under a saturated queue.
- **The soak test as a nightly**, asserting RSS plateaus with eviction on.

## ~~The `spike/` directory~~ — deleted in Phase 4

Phase 0's throwaway probes, kept because several were then the only copy of real work. The
plan below was right about *what* had to be promoted and wrong about *when*: `runaway.rs` and
the process half of `pool.rs`/`procsweep.sh` both needed the worker-process pool, which did not
exist until Phase 3, so only `interner.rs` was consumed in Phase 2.

Every probe now has a permanent home, and
[`../phase-4/00-publishing.md`](../phase-4/00-publishing.md#deleting-spike) has the mapping.

> Phase 2 consumes and then deletes `runaway.rs` (runaway compiles, pool wedging, kill cost),
> `pool.rs` + `procsweep.sh` (thread-vs-process scaling — the evidence behind the process
> pool), and `interner.rs` (the only probe reaching typst's real 65,535 cap).

## Things not to change without a reason

- **The `=0.15.1` typst pin.** Pre-1.0; it breaks across minor releases. `FileId::new` and
  `VirtualPath::new` both changed in 0.15. `world.rs` and `paths.rs` are the blast radius.
- **`unsafe_code = "forbid"`.** Confine any unavoidable `unsafe` to napi-generated code.
- **Zero `-sys` crates.** Checked by `scripts/check-no-sys-crates.sh` on every commit. It is
  what makes the 14-target matrix affordable, and it is why networking lives in TypeScript.
- **`tagged: true` as the PDF default.** Turning it off is an accessibility regression users
  would not notice. The cost is size (up to +302%), not time (+5–28%).

## Distribution constraints already known

For when Phase 4 arrives: all 14 targets were verified in Phase 0, but **the three
`win32-*-msvc` targets cannot be cross-compiled** — `stacker` compiles `windows.c`, which needs
`windows.h`, and `psm` needs `lib.exe`. They need native Windows runners. Eleven targets
cross-compile with `CC=clang` plus `CFLAGS=-target <triple>`; Android needs `AR=ar` as well.
~~`spike/xtarget/sweep2.sh` is the recipe.~~ That script is gone; the recipe is the sentence
above, and the per-target table in
[`../discovery/08-phase-0-results.md`](../discovery/08-phase-0-results.md#q5--psmstacker-across-the-target-matrix).
