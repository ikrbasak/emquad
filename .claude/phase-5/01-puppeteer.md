# Phase 5 — emquad against Puppeteer

The number that drives adoption, and the one that will be scrutinized hardest.

Measured 2026-08-02 on Apple M1 (4 performance + 4 efficiency cores), Node 26.5.1, typst 0.15.1,
Chrome for Testing 146.0.7680.177. Harness and full method in
[`../../benchmarks/puppeteer/`](../../benchmarks/puppeteer/README.md), which is published so this
can be reproduced or disputed.

## The headline, with the caveat welded on

**Between 2× and 33×, and the document decides which.** There is no single honest multiplier.

| Document | Concurrency | emquad | Puppeteer | Ratio |
|---|---|---|---|---|
| Invoice, 1 page, 8-row table | 1 | 517.5 docs/s | 15.9 docs/s | **32.6×** |
| Invoice, 1 page, 8-row table | 4 | 1,311.8 docs/s | 51.4 docs/s | **25.5×** |
| Report, 4–5 pages, 120-row table | 1 | 45.8 docs/s | 12.9 docs/s | **3.6×** |
| Report, 4–5 pages, 120-row table | 4 | 103.8 docs/s | 40.3 docs/s | **2.6×** |

**Normalized per page**, which is the fairer reading of the report row: Chromium fits fewer rows
per page and emits 5 pages where emquad emits 4, so it is doing ~25% more page-level work. At
concurrency 4 that is 415 pages/s against 201 — **2.1×**.

So: **the small-document advantage is enormous and the large-document advantage is roughly
double.** Quote 25× without saying "one-page invoice" and the first person to try it on a
50-page report will conclude the project lies.

### Why the gap closes

On a one-page invoice, Chromium's per-document cost is dominated by fixed overhead — `setContent`,
style recalculation, layout, and the print path — which emquad simply does not have. On a
120-row table spanning pages, actual typesetting dominates for both engines, and typst's
advantage narrows to what its layout engine is worth against Blink's.

That is the shape to expect generally: **the fixed cost per document is where the difference
lives.** The more real work a document contains, the more the two converge.

## Latency

| Document | Concurrency | emquad p50 / p99 | Puppeteer p50 / p99 |
|---|---|---|---|
| Invoice | 4 | 2.9 / 4.8 ms | 73.7 / 97.4 ms |
| Report | 4 | 37.7 / 52.2 ms | 94.5 / 135.8 ms |

emquad's p99 is inside Puppeteer's *p50* on both documents. For a request-serving path that
matters more than mean throughput, because it is the tail that sets timeouts.

## Memory — the largest difference, and the one nobody benchmarks

| Document | Concurrency | emquad at rest / under load | Puppeteer at rest / under load |
|---|---|---|---|
| Invoice | 4 | 91 / 92 MiB | 1,128 / **1,445 MiB** |
| Report | 4 | 100 / 291 MiB | 1,148 / **1,724 MiB** |

**An idle Chromium costs more than emquad under full load** — 1,128 MiB against 92 MiB. This is
usually the real operational difference: it decides container sizing, how many replicas fit on a
node, and whether the PDF service needs its own machine pool.

Read the emquad report figure honestly: 100 MiB at rest to 291 MiB under load is the `comemo`
cache growing, and it is bounded by eviction rather than free.

## Cold start

| | emquad | Puppeteer |
|---|---|---|
| Invoice, concurrency 1 | 9.4 ms | 535.8 ms |
| Invoice, concurrency 4 | 78.0 ms | 660.8 ms |

emquad's cold start is constructing the `Compiler` — parsing 17 font files, building the base
VFS, starting the pool — plus the first compile. Puppeteer's is launching Chromium, opening a
page, and rendering the first PDF. Both are amortized in a long-lived service and both matter in
Lambda-style invocations.

Note emquad's cold start *rises* with pool size (9.4 → 78.0 ms) because each worker parses the
font set. Puppeteer's is nearly flat: one browser, more pages.

## What this does not show, and must not be claimed

**Typst is not a Chromium replacement.** It does not render HTML. Migrating means rewriting every
template in Typst markup, and for a nontrivial invoice that is a day of work rather than an
afternoon. None of the numbers above include that cost, and for many teams it is the deciding
factor regardless of throughput.

**One machine, one platform, one Chromium build.** `darwin-arm64`, Chrome 146 rather than the
pinned 148 — the pinned build would not download, and the harness prints the version used.

**Two synthetic documents.** They were built to be equivalent rather than favourable — a "hello
world" comparison flatters typst unfairly and would be worthless — but they are still not your
templates.

**No JavaScript, no web fonts, no network.** A Puppeteer pipeline that waits on `networkidle0`
or executes chart-rendering JS in the page pays costs this harness does not measure. The
comparison is deliberately generous to Puppeteer here: `waitUntil: "load"` on inline HTML is
about the fastest it can be driven.

## One harness defect, and one false alarm

**The defect: RSS read after `browser.close()`** reports a machine with no browser on it. The
first version did exactly this and had Chromium and emquad using identical memory — 104 against
105 MiB, against a true tenfold difference. It is now sampled on a timer during the run.

**The false alarm, recorded because it was nearly written up as a product defect.** While
building this, `puppeteer.launch()` failed several times — null exit code, empty stderr —
whenever emquad had run first in the same process. The obvious reading was that a live
`Compiler` prevents Chromium from starting, which would matter enormously to anyone migrating
incrementally and expecting to run both engines during a cutover.

**It does not reproduce.** Tested directly: a constructed `Compiler` with the full font set, with
one font, after 50, 200, and 400 compiles, and after `close()` — Chromium launches every time,
five consecutive runs at the worst case. File descriptors and threads are flat across 400
compiles (23 and 20), and RSS holds at ~104 MiB, so there is no leak driving it.

The failures were **machine load** — they occurred while cargo builds and other benchmarks were
running concurrently on the same laptop. Nothing about emquad causes them.

The lesson is the reason this is written down: a reproducible-looking failure that appears
exactly when you change one variable is *not* evidence that the variable caused it, and this one
was two edits away from being published as a known issue. Separate processes remain the right
design here — for cache isolation and honest RSS — but not for the reason originally given.
