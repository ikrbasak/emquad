# emquad

A lean Node.js binding for [Typst](https://github.com/typst/typst) for PDF generation.
**VFS in → PDF out.** Positioned as a fast, light replacement for Chromium + Puppeteer PDF
pipelines.

**Status: Phases 0 and 1 complete. Phase 2 (`emquad-napi`) not started.**
`crates/emquad-engine` compiles a VFS to a PDF; 61 tests pass.

## Orientation

- [`PLAN.md`](PLAN.md) → [`plan/`](plan/) — the implementation plan, phased
- [`discovery/`](discovery/00-overview.md) — Phase 0 research findings with evidence
- [`phase-1/`](phase-1/00-overview.md) — what the Rust core is, how it works, and what it
  measured. **[`phase-1/05-handoff.md`](phase-1/05-handoff.md) is where to start if you are
  picking up Phase 2.**

**Read these three before writing any code:**

- [`discovery/02-footguns.md`](discovery/02-footguns.md) — three process-global Typst behaviors
  that dictate the API shape and are painful to retrofit.
- [`discovery/08-phase-0-results.md`](discovery/08-phase-0-results.md) — measured Phase 0
  results. It **corrects several claims** in the earlier research documents; where they
  disagree, it wins.
- [`phase-1/03-findings.md`](phase-1/03-findings.md) — what Phase 1 measured. It **corrects hard
  rule 9 and the font licensing** recorded elsewhere.

## Packages

| Package | Purpose |
|---|---|
| `@emquad/core` | Main package: TS API + native loader |
| `@emquad/fonts` | Optional default Typst fonts (~9.3 MB; **four licenses, not just OFL** — see rule 11) |
| `@emquad/resolver` | `@preview` registry resolver (TS — owns all networking) |
| `@emquad/typst-binding-<platform>` | Prebuilt native bindings, one per target |

Rust crates: `emquad-engine` (pure core, no napi) and `emquad-napi` (thin binding layer).

> The Rust crate is `emquad-engine`, **not** `emquad-core` — that would collide with the
> `@emquad/core` npm package.

## Hard rules

These come from verified findings. Violating any of them causes production failures that are
difficult to diagnose.

1. **Canonical VFS paths only — content varies, paths never do.**
   `FileId` is a process-global interner, `Box::leak`'d, capped at exactly 65,535, and it
   **panics** when exhausted (`out of file ids: TryFromIntError(PosOverflow)`). Per-request
   paths (`invoice-${uuid}.typ`) leak permanently and crash the process at ~65k renders.
   Override by *content* at a *stable* path. **Trip our own guard at ~50,000** with a message
   naming the offending path pattern.

2. **Never let a Rust panic cross into Node.** It aborts the process. `catch_unwind` at every
   FFI entry point. (Verified: `catch_unwind` does contain the interner panic above.)

3. **No `timeout` option on the compile API.** Typst has no cancellation hook and Rust threads
   cannot be forcibly killed. An option that looks like protection but silently leaks a wedged
   thread is worse than none. Untrusted templates require *process* isolation.

4. **Keep the Rust dependency tree free of `-sys` crates.** 284 crates, zero `-sys`, no
   OpenSSL/bindgen/cmake. This property is what makes the wide os/arch matrix affordable.
   It is why networking lives in TypeScript. Guard it in review.

5. **Pin exact Typst versions** (`=0.15.1`). Pre-1.0; it breaks across minor releases —
   `FileId::new` and `VirtualPath::new` both changed in 0.15.

6. **Fonts and the base VFS layer are built once on a long-lived `Compiler`.** Rebuilding the
   `FontBook` per compile invalidates the `comemo` memo cache and destroys throughput.

7. **Do not depend on `typst-kit`.** Not needed, churns heavily, and drags in HTTP/TLS.

8. **An empty font set is a hard error.** With no fonts registered, typst compiles successfully
   and emits a valid PDF with **every text run silently dropped — zero warnings**. Reject it at
   `Compiler` construction. Never let a font problem reach the user as a blank page.

9. **Pin typst's internal rayon to 1 thread**, in-process — not via `RAYON_NUM_THREADS`, which
   would also degrade a host app's own rayon use. Worth up to 43% on multi-page-run documents
   *under a saturated pool*; our pool provides the parallelism.
   **Corrected in Phase 1: it is not "never worse".** Measured single-threaded, pinning costs
   **12% on multi-run documents** and nothing on ordinary ones — with one compile in flight
   there is no contention to avoid, so spreading page runs across idle cores wins. The default
   stays on because unpinned-under-load collapses to 0.46×, which is far worse than 12%.
   Phase 2 must re-measure under its own pool rather than inherit the default.
   See [`phase-1/03-findings.md`](phase-1/03-findings.md).

10. **Benchmarks that vary one option must use disjoint document ranges per configuration.**
    Otherwise whichever runs second harvests `comemo` hits from the first. This produced a
    completely wrong Q4 result before it was caught.

11. **Ship the default font files byte-for-byte.** They are *not* all OFL — the 17 files span
    four licenses, and `NewCM10-Regular.otf` is GPL-3.0-or-later. Its Distribution Exception
    is what lets an MIT package carry it, and that exception is void the moment glyphs are
    added, removed, or re-encoded. **Subsetting the fonts to shrink the 9.3 MB would
    relicense `@emquad/fonts` as GPL-3.** Drop whole families instead. See
    [`../LICENSING.md`](../LICENSING.md).

## Conventions

- **TypeScript everywhere, ESM-only.** No CJS build. Native addons cannot be `import`ed
  directly — build with `napi build --platform --esm`.
- **emquad is MIT licensed.** Typst is Apache-2.0 and is statically linked, so
  `THIRD-PARTY-NOTICES.md` ships with the binary. See [`../LICENSING.md`](../LICENSING.md).
- **Tooling:** rustfmt + clippy for Rust, oxfmt + oxlint for JS/TS, lefthook for git hooks,
  commitlint with a closed scope list. `cargo-deny` and `cargo-about` for licenses.
  See [`phase-1/04-tooling.md`](phase-1/04-tooling.md).
- **pnpm + turbo** for the JS workspace; Cargo workspace for Rust.
- `strict: true` TypeScript. Declarations generated, never hand-written.
- Structured errors, not formatted strings: `file`, `line`, `column`, `severity`, `hints`.
- Conventional Commits; no co-author attribution in commit messages.
- American English.

## Testing

See [`plan/07-testing-strategy.md`](plan/07-testing-strategy.md).

The guiding principle: **PDF generation fails silently more often than it crashes.** A missing
glyph or dropped text run yields a valid but wrong PDF. Tests asserting only "no error thrown"
miss most real defects — golden-file rendering comparisons are the primary defense.

This is not hypothetical: Phase 0 found that an empty font set produces a **blank PDF with zero
diagnostics** and a successful compile. Any test suite that only checks for thrown errors would
pass that.

## Key measured facts

Measured on Apple M1 (4 performance + 4 efficiency cores), Typst 0.15.1. Full context in
[`discovery/07-benchmarks.md`](discovery/07-benchmarks.md) and
[`discovery/08-phase-0-results.md`](discovery/08-phase-0-results.md).

| Metric | Value |
|---|---|
| Distinct documents (realistic) | 532 µs → ~1,881 docs/sec/core |
| Cold first compile | 6.64 ms (one-time per process) |
| Thread scaling, simple documents | 3.71× at 4 threads, flat after |
| Thread scaling, many page runs | **0.46×** — collapses; processes reach 5.18× |
| `evict(2)` / `evict(16)` overhead | −9.8% / **−5.9%** — both bound RSS to ~40 MB vs ~1 GB |
| `tagged: true` cost | +5–28% time, **up to +302% output size** |
| Binary size (shipping, fonts external) | 29.4 MB uncompressed / **12.8 MB gzipped** |
| Official `typst-cli`, same basis | 45.0 MB uncompressed — **we are ~13% smaller** |

npm ships gzipped tarballs and each user installs one platform package, so **~12.8 MB is the
real per-user download**. The typst releases page shows sub-20 MB assets, but those are
xz-compressed *archives* — do not compare them against an uncompressed `.node`.

Do not use `panic = "abort"` to shrink the binary: it disables `catch_unwind`, which hard
rule 2 depends on.

The 532 µs figure is an **optimistic bound** — re-measure with production templates before
publishing. Never quote the memoized 327 µs number; it recompiles an identical document.
