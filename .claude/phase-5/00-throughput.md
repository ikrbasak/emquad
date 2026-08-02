# Phase 5 — the throughput discrepancy, resolved enough to publish

The decisive experiment prescribed by
[`../phase-1/03-findings.md`](../phase-1/03-findings.md#throughput-an-unresolved-discrepancy):
rebuild the Phase 0 probe and run it back to back against the engine on one machine.

Run on 2026-08-02, Apple M1 (4 performance + 4 efficiency cores), typst 0.15.1, `release`
profile (`lto = true`, `codegen-units = 1`) for both. The Phase 0 probe was recovered from git
history at `44c4eea`, where `spike/` was deleted.

**The 23% gap was mostly measurement error. What survives is ~15%, and it is not where anyone
was looking.**

## What was believed

| | Figure | Source |
|---|---|---|
| Phase 0 probe, distinct invoices | 532 µs / 1,881 docs/s | [`../discovery/07-benchmarks.md`](../discovery/07-benchmarks.md) |
| Engine benchmark, distinct invoices | 652 µs / 1,533 docs/s | [`../phase-1/03-findings.md`](../phase-1/03-findings.md) |

~23% apart, unexplained across three phases. The standing hypothesis list named per-compile
wrapper cost — `catch_unwind`, the interner lookup, the settings conversion — and the two-layer
VFS resolution.

## Three findings

### 1. The benchmark measured a configuration no user gets

`benches/compile.rs` read its rayon pinning as `EMQUAD_PIN != "0"`, so **absent the variable it
pinned**. `CompilerBuilder` derives `Default`, so `pin_rayon` is `false` — the library does not
pin. The headline number was therefore measured in a non-default configuration, and hard rule 9
had already established pinning costs ~15% at low concurrency.

Measured here at 400 documents: **766 µs pinned against 726 µs unpinned, ~5–7%.**

Fixed: the default is now unpinned, matching the library, and `EMQUAD_PIN=1` opts in.
`scripts/benchcmp.sh` passes the variable explicitly and is unaffected.

### 2. The 532 µs figure does not reproduce

The *original Phase 0 binary*, rebuilt from the original source, measures **616 µs** on this
machine today — not 532 µs. Six alternating single-threaded runs of `pool 400 1`: 1,617, 1,653,
1,646, 1,653, 1,640, 1,648 docs/s.

So a meaningful part of the "gap" was never a gap between the two codebases. It was a comparison
of numbers taken on a differently-loaded machine months apart. **Absolute figures from separate
sessions were never comparable**, which is the same lesson as hard rule 10 one level up: it is
not enough to control the document, the *session* has to be controlled too.

**Do not quote 532 µs again.** It is not reproducible on the hardware that produced it.

### 3. Per-compile wrapper overhead is approximately zero — which refutes the hypothesis list

Giving the Phase 0 probe the same three-row shape as the engine benchmark (`spike/phase0`'s
`rows` bin, written for this experiment) makes the rows directly comparable. Five alternating
pairs, 400 documents each:

| Row | Phase 0 probe | Engine (unpinned) | Δ |
|---|---|---|---|
| Memoized | 315.3 µs | 316.5 µs | **+0.4%** |
| Distinct | 615.9 µs | 711.9 µs | **+15.6%** |

The memoized row is where wrapper cost would show *undiluted*: `comemo` makes the typesetting
nearly free, so what remains is per-compile scaffolding. It is identical to within noise.

`catch_unwind`, `VfsPath::intern`, `PdfSettings::to_options`, the fresh `EmquadWorld` per
compile, and diagnostic conversion **together cost about 1 µs.** Every one of them was on the
suspect list. None of them is the cause.

Phase 1 reached the opposite conclusion from an asymmetry — its memoized row was *faster* than
Phase 0's (309 µs against 327 µs) — and reasoned that wrapper overhead would have slowed both
rows. The reasoning was sound; the inputs were two different sessions. Measured in one session
the asymmetry disappears.

## What is left, and what it is not

**~15.6%, inside compile work rather than around it.** Ruled out by measurement, not argument:

- **Wrapper overhead** — the memoized row above.
- **Rayon pinning** — measured separately at ~5–7%, and both figures above are unpinned.
- **Font handling** — `FontRegistry::font` is `self.fonts.get(index).cloned()`, character for
  character what the probe does, over the same `typst_assets` faces and the same face count.
- **The two-layer VFS** — `resolve` is two hashmap lookups, and it is on the memoized path too.
- **The clock** — `pdf_timestamp()` is one call per compile, not per element.

The residue is real, reproducible, and localized to work `comemo` skips when a document is
byte-identical. It is not diagnosed. Profiling is the next step, and it is a genuine
optimization opportunity rather than a defect.

## The publishable number

Engine, invoice, distinct documents, **library defaults**, 2000 compiles per run:

| | Value |
|---|---|
| Distinct documents | **~705 µs → ~1,420 docs/sec/core** |
| Range across three runs | 660–742 µs |
| Cold first compile | 3.3 ms warm OS cache, 10.3 ms first ever |
| Memoized | ~332 µs — **never quote** |

Caveats that still apply, and must travel with the number:

- **One synthetic invoice**, varying only a substituted integer. Documents whose every table row
  differs will be slower. This remains an optimistic bound, exactly as Phase 0 said.
- **One machine**, and a noisy one — the 12% spread above is concurrent load, not measurement
  precision.
- **Per core.** It is not a server throughput figure; see the pool guidance for that.

The Puppeteer comparison is the number that actually drives adoption, and it is still not
measured.
