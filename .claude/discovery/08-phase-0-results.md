# Phase 0 — Spike Results

Answers to the five gate questions in [`../plan/01-phase-0-spike.md`](../plan/01-phase-0-spike.md).
Measured on **Apple M1 (4 performance + 4 efficiency cores)**, Typst 0.15.1, release profile,
2026-07-29.

**Two findings change decisions already recorded in the plan.** They are marked ⚠ below.

| Question | Answer | Impact |
|---|---|---|
| Q1 Runaway mitigation | Partly — typst catches more than expected; memory bombs remain | Process pool is a real deliverable |
| Q2 Memory over long runs | Eviction works: 40 MB vs ~1 GB | Confirms eviction-on-by-default; prefer `evict(16)` |
| Q3 Pool scaling | ⚠ Threads collapse on some document shapes where processes scale | Concurrency model needs revision |
| Q4 `tagged: true` cost | Modest time, **up to 4× output size** | Keep default, document loudly |
| Q5 `psm`/`stacker` targets | All 14 viable; ⚠ Windows cannot be cross-compiled | CI matrix needs native Windows runners |
| *(unplanned)* Missing fonts | ⚠ Blank PDF, **zero diagnostics** | Phase 1 must reject an empty font set |

---

## Q1 — Runaway compiles

### Typst 0.15 catches more than the research assumed

[`02-footguns.md`](02-footguns.md#3-there-is-no-cancellation-or-timeout-api) concluded that only
a `MAX_DEPTH` recursion guard exists. That understates it. Three separate guards fire:

| Pathological input | Outcome | Guard |
|---|---|---|
| `while true { ... }` | Rejected before running | Static lint: "condition is always true" |
| `while n > 0 { s = s + 1 }` | Clean error in 353 ms | `MAX_ITERATIONS = 10_000` (`typst-eval/src/flow.rs:81`) |
| `f(n) = f(n + 1)` | Clean error in 351 ms | `MAX_DEPTH` — "maximum function call depth exceeded" |
| 100k-deep nested `box()` | Clean error in 110 ms | `MAX_DEPTH` |

All four return **diagnostics, not hangs**. That is a much better baseline than expected.

### What is still unbounded

`MAX_ITERATIONS` guards **`while` loops only**. `for` loops have no iteration limit, and that is
where the real exposure lives:

| Pathological input | Outcome |
|---|---|
| `for i in range(100000000) { s = s + i }` | **2.1 GB RSS in 2.5 s**, never completes |
| `while n > 0 { a.push(range(10000)) }` | **2.4 GB RSS in 0.47 s**, never completes |
| `for i in range(10000) { for j in range(10000) {...} }` | Runs indefinitely, **flat memory** — nothing detects it |

Note `range()` materializes a real array, so `range(100000000)` allocates ~1.6 GB on its own.

**The realistic threat is memory exhaustion and nested `for` loops, not infinite `while` loops.**
A 4M-iteration nested loop completes in 1.0 s, so typst evaluates ~4M iterations/sec — a
malicious document does not need to be exotic to wedge a worker for minutes.

### Blast radius: one thread, not the pool

With one worker wedged on an unbounded nested `for` loop and three healthy workers alongside it,
**all 600 healthy documents completed in 505 ms.** The wedged thread never returns and cannot be
joined, but it does not stall its peers.

So a thread pool degrades by exactly one worker per wedged compile. It does not deadlock. It
also never recovers that thread.

### Cost of process isolation

| Strategy | Per document | vs in-process |
|---|---|---|
| In-process | 877 µs | — |
| Fresh child process per compile | 9,819 µs | **11.2× slower** |

The ~8.9 ms delta is process spawn plus the 6.6 ms cold-compile cost of an empty memo cache.

**Do not ship process-per-compile.** A *reusable* worker process amortizes the cold cost and
pays only IPC per document, which is the pattern to build. Supervision works well: killing a
runaway child took **22–35 ms** and reliably reclaimed all memory.

### Verdict

Untrusted templates need process isolation, as previously concluded — but a persistent worker
**process** pool, not a process per compile. Q3 independently reaches the same conclusion, which
raises its priority from "consider later" to a genuine deliverable.

---

## Q2 — Memory over a long run

100,000 distinct compiles of the reference invoice, sampling RSS throughout.

| Policy | µs/doc | docs/sec | Final RSS | Growth over baseline |
|---|---|---|---|---|
| No eviction | 636.9 | 1,570 | 933 MB | **+902 MB** |
| `evict(2)` every compile | 706.4 | 1,416 (−9.8%) | 39.8 MB | **+8.5 MB** |
| `evict(16)` every compile | 676.7 | 1,478 (−5.9%) | 45.3 MB | **+13.9 MB** |

**Eviction works, and it is the difference between 40 MB and ~1 GB.** RSS plateaus within the
first few thousand documents and stays flat for the remaining 95,000 — this is a bounded
working set, not slowed growth.

Without eviction, RSS climbs to ~1.1 GB within 12k documents and then oscillates between
**0.68 GB and 1.14 GB** for the rest of the run. So it is not strictly unbounded, but it settles
roughly **20× higher** than with eviction and swings by half a gigabyte, which on a container
with a memory limit is an OOM kill waiting for the wrong moment.

The −9.8% cost of `evict(2)` closely corroborates the ~9% measured independently in
[`07-benchmarks.md`](07-benchmarks.md).

### Prefer `evict(16)` to `evict(2)` as the default

`evict(16)` costs **−5.9%** instead of −9.8% and still bounds RSS at 45 MB. That is roughly half
the throughput penalty for 6 MB more memory. Treat the exact figure as indicative — the two
differ by ~4% and deserve confirmation on production templates — but the shape of the tradeoff
favors a larger `max_age` than the plan currently assumes.

Eviction stays **on by default**; only the recommended `max_age` changes.

### The `FileId` interner, measured

Footgun #1 confirmed exactly as documented, with three useful specifics:

- **The cap is 65,535.** Interning 65,535 distinct paths succeeds; the 65,536th panics with
  `out of file ids: TryFromIntError(PosOverflow)`.
- **`catch_unwind` does contain it.** The process survives. Hard rule 2's mitigation genuinely
  works for this panic — it is not merely theoretical.
- **Leak cost is ~211 bytes per path** (13.5 MB at 65k). Memory is not the problem; the crash is.

Our own guard should trip well before 65,535 with an actionable message naming the offending
path pattern. A budget of ~50,000 leaves ample headroom for legitimately mounted `@preview`
packages while still failing early enough to be diagnosable.

---

## Missing fonts produce a silently blank PDF ⚠

Not one of the five questions, but the most important thing found in Phase 0.

With an **empty `FontBook`** — exactly what a user who skips `@emquad/fonts` gets — typst
compiles successfully and emits a **valid PDF with every text run silently dropped**:

| Scenario | Result |
|---|---|
| SVG `<text>`, fonts registered | Rendered (5,516 B vs 2,853 B without the text element) |
| SVG `<text>`, unknown `font-family` | Correctly falls back to an available font |
| SVG `<text>`, **no fonts registered** | **Dropped** — 2,853 B, identical to the text-free SVG |
| **Body text**, no fonts registered | **Dropped** — also 2,853 B |
| Warnings or errors emitted | **None. Zero diagnostics. Compile reports success.** |

The good news is that font *fallback* works properly when any fonts exist, so the SVG-specific
concern raised in the plan is unfounded. The real hazard is broader and worse: **no fonts at all
yields a blank document with no diagnostic of any kind.**

This is precisely the failure mode `CLAUDE.md` names as the guiding testing principle — "PDF
generation fails silently more often than it crashes." A test asserting "no error thrown" passes
here while producing a blank page.

**Phase 1 requirement:** `Compiler` construction must reject an empty font set outright, and a
compile that resolves zero glyphs for non-empty text must surface a structured diagnostic. Do
not rely on typst to report it — it does not.

---

## Q3 — Throughput vs. pool size ⚠

### Simple documents: scales to the performance-core count

Single-page invoice, our own thread pool:

| Threads | docs/sec | Speedup | Efficiency |
|---|---|---|---|
| 1 | 1,566 | 1.00× | 100% |
| 2 | 3,100 | 1.98× | 99% |
| 3 | 4,573 | 2.92× | 97% |
| **4** | **5,802** | **3.71×** | 93% |
| 6 | 6,231 | 3.98× | 66% |
| 8 | 6,152 | 3.93× | 49% |
| 16 | 5,941 | 3.79× | 24% |

Near-linear to 4, then flat. This machine has exactly **4 performance cores**; the 4 efficiency
cores add only ~7%.

**This plateau is hardware, not lock contention.** Separate processes — which share no `comemo`
cache at all — plateau at the same point (4.12× at 4 processes, 4.57× at 16). Threads actually
*beat* processes at the plateau (6,231 vs 4,969 docs/sec) because they share the memo cache and
font data.

### ⚠ Complex documents: threads collapse where processes scale

The picture inverts for documents with many **page runs** (a page run is a page-configuration
boundary — `#set page(...)` applied repeatedly — not a page). A 40-run document:

| Concurrency | 1 | 2 | 3 | 4 | 8 | 16 |
|---|---|---|---|---|---|---|
| **Threads** (docs/sec) | 248 | **325** | 301 | 218 | 115 | 113 |
| **Processes** (docs/sec) | 152 | 323 | 429 | 567 | 744 | **788** |

Threads peak at 2 and then fall **below single-threaded throughput** (0.46× at 10+). Processes
scale monotonically to 5.18×. At 16-way, processes are **7× faster than threads**.

The only difference between the two columns is process-global shared state. `comemo`'s global
cache is the prime suspect: its traffic scales with the number of memoized units, and the
document shapes degrade exactly in that order — invoice (1 page run) scales fine, report
(1 page run, heavy content) degrades mildly, multi-run (40 page runs) collapses. The global
allocator is a secondary candidate. **Profile this properly in Phase 2** before finalizing pool
defaults.

### Typst's internal rayon: pin it to 1 thread

`typst-layout` parallelizes page runs across the **global rayon pool**
(`typst-layout-0.15.1/src/pages/mod.rs:185`). Because it iterates *runs* rather than pages, a
normal document has exactly one item and rayon never engages — which is why `RAYON_NUM_THREADS`
made no measurable difference for the invoice or the report.

On multi-run documents it engages, and it **hurts**:

| Threads | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| rayon default | 192 | 247 | 211 | 159 |
| `RAYON_NUM_THREADS=1` | **248** | **325** | **301** | **218** |
| Gain | +29% | +32% | +43% | +37% |

Pinning rayon is faster **even at pool size 1**, so this is not merely an oversubscription
artifact — rayon's overhead exceeds its benefit at this granularity. It is never worse in any
configuration measured.

**Do it in-process, not via the environment variable.** `RAYON_NUM_THREADS` affects the whole
process, including a host application's own rayon usage. Prefer building the global pool
ourselves and handle the case where the host already initialized it (`build_global()` fails if
so — that must not be fatal).

### Recommended defaults

- Default pool size = `available_parallelism()`. On heterogeneous CPUs (Apple silicon,
  big.LITTLE) throughput saturates near the performance-core count and the remainder adds ~7%
  while increasing latency variance. On homogeneous server CPUs all cores count.
- Pin typst's rayon usage to 1 thread.
- Expose pool size as a knob, and **document that scaling depends on document shape** — this is
  not a number we can pick correctly for every workload.

---

## Q4 — What `tagged: true` costs

`PdfOptions.tagged` defaults to `true` (`typst-pdf-0.15.1/src/lib.rs`), enabling PDF/UA
accessibility tagging.

| Document | Time | Output size |
|---|---|---|
| Invoice (1 page) | +5.3% | +17.7% (18.7 KB → 22.1 KB) |
| Report (content-heavy) | +28.1% | **+302%** (65.7 KB → 264.0 KB) |
| Invoice, export step only | +11.6% | — |
| Report, export step only | +32.6% | — |

**The cost is output size, not time.** On content-heavy documents a tagged PDF is roughly **4×
larger**. For a service generating millions of PDFs, that is a storage and bandwidth line item
far more significant than the CPU overhead.

**Keep the upstream default of `true`.** Silently flipping it to `false` would be an
accessibility regression users would not notice, and some need PDF/UA for compliance. Expose it,
document the 4× size figure prominently, and let users opt out knowingly.

> **Measurement note.** A first attempt reported +139% time, which was wrong: both
> configurations compiled the same document sequence, so whichever ran second harvested `comemo`
> hits from the first. Benchmarks that vary one option must use **disjoint document ranges**
> per configuration. This trap will recur in the Phase 1 benchmark suite.

---

## Q5 — `psm`/`stacker` across the target matrix

### All 14 targets are viable

`psm` ships hand-written assembly for every architecture in the matrix (x86, x86_64, arm,
aarch64, wasm32 — `psm-0.1.31/build.rs`). No target is unsupported.

`cargo check` for each triple (build scripts run, which is where `psm` assembles):

| Result | Targets |
|---|---|
| **OK, no extra tooling** | `darwin-arm64`, `darwin-x64`, `freebsd-x64`, `wasm32-wasip1-threads` |
| **OK with `CC=clang -target …`** | `linux-x64-gnu`, `linux-arm64-gnu`, `linux-arm-gnueabihf`, `linux-x64-musl`, `linux-arm64-musl` |
| **OK with `CC=clang` + `AR=ar`** | `android-arm64`, `android-arm-eabi` |
| ⚠ **Requires a Windows host** | `win32-x64-msvc`, `win32-arm64-msvc`, `win32-ia32-msvc` |

The initial failures were *missing cross C compilers on the macOS host*, not missing psm support:
`cc-rs` looks for a target-prefixed gcc (`x86_64-linux-gnu-gcc`). Since psm only needs to
*assemble* a `.s` file — no libc headers — plain `clang -target <triple>` suffices. This is
effectively what `napi build --use-napi-cross` and `zig cc` provide in CI.

### ⚠ Windows targets cannot be cross-compiled

`stacker` compiles a C file on every Windows target
(`stacker-0.1.24/build.rs` → `src/arch/windows.c`), which does `#include <windows.h>` to call
`GetCurrentFiber()`. `psm` additionally needs MSVC's `lib.exe`. Both require the real Windows SDK.

**The three `win32-*-msvc` packages must be built on a native Windows runner.** This is normal
for GitHub Actions (`windows-latest`) but it is a hard constraint on the release pipeline, and
it invalidates any plan to produce the whole matrix from a single Linux container.

It also qualifies the "no C toolchain needed" framing in
[`06-distribution.md`](06-distribution.md): true everywhere except Windows.

### The wasm stack caveat is real, but the mechanism differs

[`06-distribution.md`](06-distribution.md#the-wasm32-wasip1-threads-fallback-is-not-equivalent)
says "`stacker` cannot grow the stack on wasm". The conclusion holds; the reason is different.

`typst-eval` gates the dependency out entirely — `typst-eval-0.15.1/Cargo.toml:80` declares
stacker under `[target.'cfg(not(target_arch = "wasm32"))'.dependencies]`, and the call site
carries the comment *"Stacker is broken on WASM."* So on wasm the evaluator simply calls through
without growing the stack; stacker is not in the dependency graph at all.

Practical effect is unchanged: **deeply-nested documents that succeed natively can overflow on
the wasm fallback.** `MAX_DEPTH` still applies, so this bounds how deep it can get.

---

## Bonus — `opt-level` size/throughput tradeoff

[`07-benchmarks.md`](07-benchmarks.md#size-levers-assessed) listed `opt-level = "z"/"s"` as
"measure in Phase 0, adopt only if the regression is negligible." Measured, on the
fonts-embedded probe binary:

| `opt-level` | Binary | gzip -9 | docs/sec | Throughput cost |
|---|---|---|---|---|
| **`3`** (current) | 39.25 MB | 19.27 MB | **1,435** | — |
| `"s"` | 35.04 MB (−10.7%) | 17.35 MB (−10.0%) | 1,304 | **−9.1%** |
| `"z"` | 29.68 MB (−24.4%) | 16.22 MB (−15.8%) | 664 | **−53.7%** |

**Verdict: keep `opt-level = 3`. Reject both.**

`"z"` halves throughput for a 15.8% download saving — a terrible trade for a package whose entire
value proposition is speed. `"s"` is closer to break-even but still costs 9.1% throughput for a
10% saving, and we are already 13% smaller than upstream `typst-cli`. Not worth it.

> These binaries embed fonts, so the *percentage* size reduction on the shipping (fonts-external)
> binary would be somewhat larger, since the ~9.3 MB of font data is unaffected by `opt-level`.
> The throughput cost is unchanged either way, and it is what decides this.

This closes the last open item in the size-levers table: every lever is now either adopted
(fonts external) or rejected with a measurement.

---

## Deliverables

- **Findings:** this document.
- **Harness:** preserved at [`../../spike/`](../../spike/) — see its README. It is throwaway
  code and not part of the build; Phase 1 should promote the useful probes into
  `crates/emquad-engine/benches/` so these numbers stay honest as the code evolves.
- **Go/no-go:** recorded in [`../plan/00-overview.md`](../plan/00-overview.md#decisions--with-phase-0-gono-go).

### Still not measured

Carried forward rather than answered here:

- Real production templates rather than synthetic ones. The 532 µs figure remains an
  **optimistic bound**.
- A Puppeteer comparison on an equivalent document — the number that actually drives adoption.
- Where the multi-run thread contention actually lives (`comemo` vs. the global allocator).
  Profile in Phase 2 before finalizing pool defaults.
- Practical nesting depth on the `wasm32-wasip1-threads` fallback. Requires a wasm runtime to
  measure; `MAX_DEPTH` bounds it, so this affects documentation precision, not viability.

---

## Corrections to earlier documents

| Document | Claim | Correction |
|---|---|---|
| [`02-footguns.md`](02-footguns.md) | Only `MAX_DEPTH` guards runaway compiles | Also a `while true` lint and `MAX_ITERATIONS = 10_000` for `while` loops; `for` loops remain unguarded |
| [`03-concurrency.md`](03-concurrency.md) | A dedicated thread pool is sufficient | True for simple documents; threads collapse on many-page-run documents where processes scale 7× better |
| [`06-distribution.md`](06-distribution.md) | Zero `-sys` crates, no C toolchain | Holds except Windows, where `stacker` compiles `windows.c` |
| [`06-distribution.md`](06-distribution.md) | `stacker` cannot grow the stack on wasm | Correct, but because typst gates the dependency out, not because psm lacks support |
| [`06-distribution.md`](06-distribution.md) | ~28 MB per platform, `typst-cli` is 35–40 MB | 29.4 MB / 12.8 MB gzipped; `typst-cli` is 45.0 MB (updated in place) |
