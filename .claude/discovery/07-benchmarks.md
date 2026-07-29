# Benchmarks

All numbers measured on **Apple M1, 8 cores**, 2026-07-29, Typst 0.15.1, single-threaded,
release profile (`lto = true`, `codegen-units = 1`, `strip = true`, `opt-level = 3`).

The probe implements a real `World` over an in-memory VFS and runs the full
`typst::compile` → `typst_pdf::pdf` pipeline.

## Test document

One A4 page containing: a heading, styled text with a custom color, a 3-column `#table`
with a header row and per-row fill callback, and a linear-gradient `#rect`.
Output: ~21.6 KB PDF.

Deliberately representative of an invoice/report — the actual target workload.

## Results

| Scenario | Per document | Throughput (1 core) |
|---|---|---|
| Cold first compile (empty memo cache) | **6.64 ms** | — |
| Same document repeated (fully memoized) | 327 µs | 3,060/s |
| **Distinct documents** | **532 µs** | **1,881/s** |
| Distinct documents + `evict(2)` each iteration | 580 µs | 1,725/s |

## Reading these honestly

**Use the 532 µs / 1,881 per second figure.** The other rows are diagnostics.

- **The 327 µs row is misleading and is included only to show that.** It recompiles a byte-identical
  document, so `comemo` serves almost everything from cache. No real server does this. Quoting it
  would be dishonest marketing.
- **The 532 µs row is still a floor, not a ceiling of realism.** The probe varies only the
  document title between iterations, so layout is nearly identical and sub-document memoization
  still hits. Real documents where every table row differs will be somewhat slower. Treat 532 µs
  as an optimistic bound and re-measure with production templates before publishing any number.
- **The cold 6.64 ms** is a one-time, per-process cost, not per request. It matters for
  short-lived Lambda-style invocations, and is a good argument for a warm-up compile at startup.

## The most actionable finding: eviction is cheap

`comemo::evict(2)` on *every* compile costs only **~9%** throughput (532 µs → 580 µs).

This matters a lot. Footgun #2 in [02-footguns.md](02-footguns.md) is unbounded cache growth,
and the obvious worry is that bounding memory would cost real throughput. It does not.

**Therefore: default to eviction on.** Bounded memory should be the out-of-the-box behavior,
with tuning available for users who want to trade memory for the last 9%. Do not ship
unbounded-by-default and make people discover the leak.

## Sanity check against the motivating benchmark

Zerodha reported 1.5M PDFs in 25 minutes ≈ **1,000 PDFs/sec** across their whole fleet.
A single M1 core here does 1,881/sec on a simpler document. The order of magnitude is
consistent, which is a good sign the measurement is not accidentally wrong.

## Binary size

**The shipping configuration (fonts excluded) is 29.4 MB uncompressed / 12.8 MB gzipped.**
Since npm distributes gzipped tarballs and each user installs exactly one platform package,
**~12.8 MB is the real per-user download.**

| Configuration | Uncompressed | gzip -9 | xz -9 |
|---|---|---|---|
| **Shipping: full pipeline, fonts external** | **29.4 MB** | **12.8 MB** | — |
| Full pipeline + embedded fonts | 39.2 MB | 19.3 MB | 13.0 MB |
| Font data alone (`typst-assets`) | ~9.3 MB | — | — |

### Compared against official `typst-cli` 0.15.1 (darwin-arm64)

| | Uncompressed | Compressed |
|---|---|---|
| Official `typst-cli` (embeds fonts) | **45.0 MB** | 14.4 MB (xz) |
| Ours, same basis (embeds fonts) | **39.2 MB** | 13.0 MB (xz) |

**We are ~13% smaller than upstream on identical terms.**

Note the GitHub releases page shows assets under 20 MB — those are **xz-compressed archives**,
not binaries. Comparing them against an uncompressed `.node` is apples-to-oranges and makes
our build look bloated when it is in fact leaner than upstream's.

For context, Puppeteer downloads a full Chromium (roughly 170 MB+). At ~12.8 MB, install
footprint is a point in this package's favor, not against it.

### Size levers, assessed

| Lever | Effect | Verdict |
|---|---|---|
| Fonts as a separate package | −9.3 MB | **Adopted** |
| `panic = "abort"` | ~5–10% | **Rejected** — disables `catch_unwind`, which we need because the `FileId` interner panics via `expect`. An uncaught panic aborts the Node process. |
| `opt-level = "z"`/`"s"` | −16% / −10% gzipped | **Rejected — measured.** `"z"` costs **53.7%** throughput, `"s"` costs **9.1%**. Throughput is the value proposition and we are already smaller than upstream. See [08-phase-0-results.md](08-phase-0-results.md#bonus--opt-level-sizethroughput-tradeoff). |
| Drop `typst-html` / `typst-svg` | few MB | **Not available.** The `typst` crate exposes no feature flags, and `Library::default()` builds a `NativeRuleMap` of function pointers that keeps those paths reachable, so LTO cannot strip them either. Excluding them means hand-building a `Library` — fragile across every 0.x bump. |

~29 MB uncompressed is simply what a complete typesetting engine costs, and this build is at
the low end of that range.

### A measurement mistake worth recording

An earlier probe reported **9.7 MB**, and a fonts-free variant reported **376 KB**. Both were
wrong. Neither probe ever *called* `typst::compile`, so with `lto = true` the linker
dead-stripped the entire compile and PDF pipeline. The 376 KB figure was the giveaway — it is
impossible for a real typesetting engine.

**Lesson for future size measurements: the probe must exercise the full pipeline end-to-end,
or LTO will silently delete what you are trying to measure.**

The 9.3 MB font figure is the one useful thing that mistake produced, and it independently
confirms the decision to ship fonts as a separate package — embedding would have cost
9.3 MB × every target in the matrix.

## Measured since — Phase 0

The first three items below were open questions here and are now answered in
[08-phase-0-results.md](08-phase-0-results.md):

- **RSS over 100k compiles** — plateaus at ~40 MB with eviction, ~1 GB without.
- **Throughput vs. pool size** — 3.71× at 4 threads for simple documents; **collapses to 0.46×**
  on documents with many page runs, where processes reach 5.18×.
- **`tagged: true`** — +5–28% time, but **up to +302% output size**.

### Still not measured

- Real production templates rather than a synthetic invoice. **The 532 µs figure remains an
  optimistic bound** — re-measure before publishing any number.
- Comparison against Puppeteer on an equivalent document — the number that actually drives
  adoption.

## Reproducing

The probe source is preserved at [`../../spike/phase0/`](../../spike/phase0/). It should be
promoted into `crates/emquad-engine/benches/` during Phase 1 so these numbers stay honest as the
code evolves.
