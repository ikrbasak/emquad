# Phase 1 findings

Five things Phase 1 learned that were not known before, two of which **correct earlier
documents**. Where this file disagrees with anything in [`../discovery/`](../discovery/), this
one is newer — but note that [`../discovery/08-phase-0-results.md`](../discovery/08-phase-0-results.md)
remains authoritative for everything Phase 0 measured under load, which Phase 1 did not
reproduce.

---

## 1. Hard rule 9 is not "never worse" ⚠

**Correction to [`../CLAUDE.md`](../CLAUDE.md) hard rule 9 and
[`../discovery/03-concurrency.md`](../discovery/03-concurrency.md).**

That rule says pinning typst's internal rayon to one thread is "worth up to 43% on
multi-page-run documents and never worse". The second half is wrong.

### Measured

`./scripts/benchcmp.sh`, three repetitions per configuration, alternating order, **one
configuration per process**, 2,000 distinct documents each. Apple M1, single-threaded.

| Document | Pinned | Unpinned | Difference |
|---|---|---|---|
| Invoice (1 page run) | 652 µs | 652 µs | none |
| Multi-run (40 page runs) | 3,738 µs | 3,327 µs | **pinning is 12% slower** |

Individual runs, showing it is not noise and not an ordering artifact:

```
rep 1  pin=1    3708.0 us      rep 1  pin=0    3322.7 us
rep 2  pin=1    3761.9 us      rep 2  pin=0    3339.6 us
rep 3  pin=1    3743.3 us      rep 3  pin=0    3317.4 us
```

### Why both results are correct

Phase 0 measured `RAYON_NUM_THREADS=1` while **many worker threads compiled at once**. There,
typst's rayon oversubscribes on top of our pool and pinning recovers up to 43%.

Phase 1 measured **one compile at a time**. There is no contention to avoid, so letting rayon
spread 40 page runs across idle cores is simply faster than forcing them onto one.

The rule needs the qualifier: pinning pays **under a saturated pool** and costs ~12% on
multi-run documents when compiles are serial.

### What was decided, and what is still open

The default stays `true`, because the failure modes are asymmetric: unpinned under a saturated
pool collapsed to **0.46×** in Phase 0, and 12% on an unusual document shape is much the
smaller loss.

**This is Phase 2's call, not Phase 1's.** The engine alone provides no concurrency, so it
cannot know which regime it is in. Phase 2 must re-measure pinned against unpinned *under its
own worker pool* and set `pin_rayon` deliberately rather than inheriting a default chosen
without that measurement. The knob exists:
`Compiler::builder().pin_rayon(false)`.

---

## 2. Disjoint document ranges are not enough ⚠

**Extends hard rule 10.**

That rule says benchmarks varying one option must use disjoint document *ranges*, because
otherwise whichever configuration runs second harvests `comemo` hits from the first. Phase 1
found the rule as written is insufficient.

The first attempt at the rayon comparison above used disjoint indices — `1..=2000` against
`1_000_001..=1_002_000` — in a single process, and reported the second-measured configuration
as **20% faster**. Rerunning in separate processes showed the true difference is zero.

**Disjoint indices are not disjoint work.** Two invoices differing only in a substituted number
share nearly all of their layout: the same table structure, the same gradient, the same font
shaping. `comemo` memoizes sub-document fragments, so the first configuration pays to warm a
cache the second one harvests.

**The fix, now encoded in `scripts/benchcmp.sh`:** one configuration per process, repeated with
alternating order. Separate processes are the only reliable isolation, because `comemo` is
process-global. Alternating order stops a warm page cache or a thermal ramp from masquerading
as a result.

This is the second time a `comemo` measurement artifact produced a confidently wrong number —
Phase 0's `tagged` result was +139% against a true +5%. Treat any single-process A/B against
this engine as wrong until proven otherwise.

---

## 3. `@preview` packages need their manifest mounted

Mounting a package's source files is not enough. Typst reads `typst.toml` to find the
entrypoint, and without it the import fails with:

```
file not found (searched at @preview/example:0.1.0/typst.toml)
```

**This is a requirement on the Phase 3 resolver**: whatever it caches and hands to the engine
must include `typst.toml`, not just the `.typ` files. It is easy to miss because the error
names a file the caller never asked for.

Covered by `package_files_are_importable` and `errors_inside_a_package_report_the_package_path`
in [`tests/compile.rs`](../../crates/emquad-engine/tests/compile.rs).

---

## 4. `tagged: true` and `page_ranges` are mutually exclusive

Typst rejects the combination, but only at **export** — after a full compile has been paid for
— and the diagnostic has no position and no hint:

```
cannot enable tagged PDF and export a page range
```

Since `tagged` defaults to `true`, anyone reaching for `page_ranges` hits this on their first
try. `PdfSettings::to_options` now rejects it before any compile work happens, with a hint
naming the fix. The reasoning is sound and worth stating: an accessibility structure tree
describes the whole document and cannot describe a subset of it.

---

## 5. The default fonts are not OFL ⚠

**Correction to [`../plan/04-phase-3-typescript.md`](../plan/04-phase-3-typescript.md) and
[`../plan/06-phase-5-docs-benchmarks.md`](../plan/06-phase-5-docs-benchmarks.md)**, both of
which said "the fonts are OFL".

Verified against the `NOTICE` file shipped in `typst-assets` 0.15.1, the 17 files that
`typst_assets::fonts()` yields carry **four** licenses:

| Files | License |
|---|---|
| `LibertinusSerif-*.otf` (6) | SIL Open Font License 1.1 |
| `NewCMMath-*.otf` (3), `NewCM10-{Bold,Italic,BoldItalic}.otf` (3) | GUST Font License 1.0 (LPPL 1.3c or later) |
| `NewCM10-Regular.otf` (1) | **GPL-3.0-or-later** with Font and Distribution Exceptions |
| `DejaVuSansMono*.ttf` (4) | Bitstream Vera / DejaVu |

`NewCM10-Regular.otf` being GPL-3 is shippable only because of its Distribution Exception,
which is conditional:

> If however you distribute a copy of the fonts that modifies either the glyphs (one or more)
> or the glyph-set by adding or removing glyphs, this exception is invalidated and your program
> has to follow GPL version 3 (or later).

**Subsetting the fonts to shrink the 9.3 MB would relicense `@emquad/fonts` as GPL-3.** That is
a live risk, not a theoretical one: the fonts are the largest single item in the install
footprint and subsetting is the obvious way to shrink them.

Now recorded as **hard rule 11**. Full breakdown and the required packaging test in
[`../../LICENSING.md`](../../LICENSING.md).

---

## Throughput: an unresolved discrepancy

`cargo bench --bench compile` reports **652 µs / 1,533 docs/s** on the invoice.
[`../discovery/07-benchmarks.md`](../discovery/07-benchmarks.md) records **532 µs / 1,881
docs/s** from the Phase 0 probe. That is ~23% apart and **it has not been explained.**

What is known:

- It is not a slower machine. The memoized row is *faster* than Phase 0's — 309 µs against
  327 µs — measured in the same runs.
- That asymmetry argues against per-compile wrapper overhead: `catch_unwind`, the interning
  lookup, and the settings conversion would slow both rows, not just one.
- It is not the rayon pinning. Unpinned measures the same 652 µs (finding 1).

Candidates not yet tested: a different iteration count in the Phase 0 run (cache warming
amortizes differently), different `PdfOptions`, or a genuine cost in the two-layer VFS
resolution on typst's hot `source()` path.

**Do not publish a throughput number until this is resolved.** Phase 0 already flagged 532 µs
as an optimistic bound requiring re-measurement against production templates; this discrepancy
is a second, independent reason to treat both figures as provisional. The decisive experiment
is to rebuild `spike/phase0` and run it against this engine on the same machine, back to back.

---

## Confirmations

Things Phase 0 predicted that Phase 1 reproduced without surprises:

- **`catch_unwind` at the compile boundary works.** No panic escaped in any test.
- **The interner guard fires cleanly**, reports the offending pattern, and does not prevent
  already-interned paths from being reused.
- **An empty font set really does compile.** The unit test asserting `Error::NoFonts` exists
  because typst is otherwise perfectly happy to emit a blank PDF.
- **Parallel compiles are byte-identical to serial ones** across 16 threads sharing one
  `Compiler`, despite `comemo`, the interner, and the font book all being process-global.
- **The dependency tree is still free of `-sys` crates** — 293 packages, verified by
  `scripts/check-no-sys-crates.sh`, and every license permissive.
