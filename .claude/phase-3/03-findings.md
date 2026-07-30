# Phase 3 findings

What was measured, and what it corrects. Where an earlier document disagrees with this one on a
Phase 3 subject, this one wins.

Measured on Apple M1 (4 performance + 4 efficiency cores), Typst 0.15.1, **release** build with
LTO. One configuration per process, disjoint document ranges per configuration, orders alternated
between rounds — hard rule 10, and it matters more here than anywhere else so far.

## 1. The worker-process pool works, and the effect is larger than Phase 0 predicted

This is the headline result of Phase 3 and it settles the question the pool was built to answer.

**Multi-run documents** — forty page runs, the shape whose throughput collapsed in Phase 0
(`./packages/core/bench/poolcmp.sh multirun 120`, docs/sec, two rounds averaged):

| Pool size | Threads | Processes | Processes ÷ threads |
|---|---|---|---|
| 1 | 309 | 307 | 0.99× |
| 2 | 234 | 552 | **2.36×** |
| 4 | 188 | 720 | **3.83×** |
| 8 | 98 | 679 | **6.93×** |

Read the thread column vertically. Throughput does not merely fail to scale — it *falls*, to
**0.32× at eight threads** against a single thread. Phase 0 measured 0.46×; the fuller collapse
here is consistent with that and worse.

Processes scale to **2.35× at four**, then plateau, which is exactly the shape of a machine with
four performance cores.

**Single-run documents** — an invoice, the common case (`poolcmp.sh invoice 800`):

| Pool size | Threads | Processes | Processes ÷ threads |
|---|---|---|---|
| 1 | 1,510 | 1,472 | 0.97× |
| 2 | 2,812 | 2,434 | 0.87× |
| 4 | 4,859 | 4,085 | 0.84× |
| 8 | 5,364 | 3,561 | 0.66× |

Here threads win, scaling 3.22× at four and 3.55× at eight — closely reproducing Phase 0's 3.71×
at four, flat after.

### What this means for the default

**`pool.mode` is a document-shape decision, not a performance dial**, and the two shapes want
opposite answers:

- Single page run: threads are up to **1.5× faster**.
- Many page runs: processes are up to **6.9× faster**.

`"thread"` stays the default because an ordinary document has exactly one page run — a run is
created by page *re-configuration*, not by page count, so even a 200-page report is single-run.
Documents that re-configure pages repeatedly are the exception, and they now have an answer.

## 2. Font descriptors help less than the design claimed

The Phase 2 handoff flagged shipping fonts to every worker as "the expensive part — measure it."
Measured (`bench/fonts.js`, 9.3 MB default set, five runs each, mean):

| Workers | `{ file }` descriptors | Raw `Uint8Array` | IPC avoided |
|---|---|---|---|
| 1 | 54 ms | 50 ms | 9.3 MB |
| 4 | 62 ms | 63 ms | 39 MB |
| 8 | **80 ms** | 103 ms | 77 MB |

So descriptors are worth about **23 ms at eight workers** and nothing at all below four. Real,
free, and worth keeping — but startup is dominated by spawning processes and parsing fonts inside
each of them, neither of which the descriptor form avoids.

Doc comments written before this measurement described it as "the single most expensive thing the
pool would otherwise do." That was wrong and has been corrected in `types.ts`, `protocol.ts`,
`compiler.ts`, and `@emquad/fonts`.

**Process-pool startup is ~44–100 ms** in total, against ~4 ms for the thread pool. One-time, and
irrelevant to any long-lived server.

## 3. Two silent-failure modes in SVG text, one of them severe

Found while building the golden-file suite, and both are live in Typst 0.15.1.

An SVG whose `font-family` names a face that is not registered produces **no diagnostic at all** —
not an error, not a warning. What happens instead depends on what *is* registered:

| Registered fonts | Result |
|---|---|
| Libertinus Serif | Text renders, substituted. 156 ink pixels. |
| Libertinus + DejaVu Mono | Text renders, substituted. 156 ink pixels. |
| DejaVu Sans Mono only | **Text vanishes. 0 ink pixels. Zero warnings.** |

The third row is the serious one. A valid PDF, a successful compile, no diagnostics, and the text
is simply not there. It is the same class of failure as an empty font set (hard rule 8) but
reachable with a font set that is merely *incomplete*, which no existing check catches.

Note the contrast with ordinary typst text: `#set text(font: "No Such Family")` **does** warn.
SVG text is not covered by that path at all.

Both behaviors are pinned by tests in `packages/core/test/golden.test.js` that assert the current
outcome exactly, including `warnings.length === 0`. They will fail if a future Typst starts
reporting this — which is the point. The tests say so in their failure messages.

**Practical advice for users:** register a serif family. Nothing in the API can detect this for
you, because typst reports nothing to detect.

## 4. Rasterized golden files are the only test that would have caught #3

Nothing else in the suite could. The compile succeeded, the PDF was valid, the page count was
right, and no error was thrown. Only counting ink on the page revealed it.

The harness was verified against a deliberate regression rather than assumed to work: removing
`table.header(...)` from the tables fixture — which stops the header repeating on pages 2 and 3 —
is caught immediately.

Two calibration notes for whoever maintains it:

- **The pixel threshold is 0.1%, not zero.** Rasterization is not bit-identical across CPU
  architectures. A real regression moves thousands of pixels; antialiasing moves tens.
- **Text is asserted before pixels.** "Page 2 text changed" is a far more useful failure than
  "0.4% of pixels differ", and a dropped text run is the most likely defect.

## 5. A runaway document has to burn CPU, not memory

The first runaway fixture was a 40,000-page document. It was wrong twice: it completes in
**682 ms**, and it exhausts the worker's memory on the way back — so the timeout test passed by
reporting `WORKER_DIED` rather than `WORKER_TIMEOUT`. The test was green and proving nothing.

The replacement is 50 million iterations of integer arithmetic: **9.9 seconds**, one page,
negligible memory. Killing it takes effect immediately, and the pool replaces the worker and
serves the next document.

## 6. A bug the timeout test found: killing a worker must retire it first

`#expire` rejected the job and sent `SIGKILL`, but the exit is asynchronous — for the tens of
milliseconds the process took to die it stayed in the pool marked `ready` with no job, so the very
next `compile()` was dispatched into it. That surfaced as a spurious `WORKER_DIED` on an unrelated
document.

The worker is now marked not-ready *before* the kill, and `#dispatch` checks `child.connected` and
requeues rather than writing into a closed channel. Both are in `pool/process-pool.ts`.

This is worth remembering as a shape, not just a fix: **anything that kills a worker must remove
it from the schedulable set synchronously**, because process death is not.

## 7. `pool.timeoutMs` is compatible with hard rule 3, and only in process mode

Rule 3 forbids a `timeout` on the compile API. Its stated reasoning is that typst has no
cancellation hook and a Rust thread cannot be killed, so the option would report failure while
leaking a wedged thread — and it closes by saying untrusted templates require *process* isolation.

`pool.timeoutMs` is that isolation. It kills a process, which works. The rule is unchanged and the
option does not exist on `compile()`.

Setting it without `pool.mode: "process"` is a **construction error**, not a no-op. That is the
part that keeps the rule intact: an option that silently did nothing in thread mode would be
exactly the fake protection rule 3 warns about.

## 8. Verified against the real registry

The resolver's mock registry could have encoded the wrong URL shape or tarball layout and every
test would still pass. One opt-in test (`EMQUAD_NETWORK_TESTS=1`) fetches
`@preview/cetz:0.4.2` from `packages.typst.org` and confirms both. It passes.

## Still unresolved, carried forward

1. **The Phase 1 throughput discrepancy is unexplained**, and Phase 3 does not resolve it: 652 µs
   against Phase 0's 532 µs on the engine benchmark. The invoice figures here (665 µs single-thread
   through the full JS stack) are consistent with the Phase 1 number rather than the Phase 0 one,
   which weakly suggests the Phase 0 measurement was the optimistic one. Not enough to conclude.
   **No throughput number should be published until this is settled.**
2. **Why per-thread rayon pinning differs from `RAYON_NUM_THREADS=1`** (Phase 2, still open). The
   process-pool result reduces the stakes considerably — the collapse now has a working answer —
   but the discrepancy itself is still unexplained.
3. **What the process-global contention actually is.** Phase 2 eliminated rayon; Phase 3 confirms
   processes escape it entirely. `comemo`'s cache remains the leading suspect and nobody has
   confirmed it.
