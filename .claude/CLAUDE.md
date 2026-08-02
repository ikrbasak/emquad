# emquad

A lean Node.js binding for [Typst](https://github.com/typst/typst) for PDF generation.
**VFS in → PDF out.** Positioned as a fast, light replacement for Chromium + Puppeteer PDF
pipelines.

**Status: Phases 0–4 complete. `0.0.1` is on npm.**
`emquad-engine` compiles a VFS to a PDF, `emquad-napi` exposes it to Node, and `@emquad/core`,
`@emquad/resolver`, and `@emquad/fonts` are the published surface, over eight prebuilt
`@emquad/typst-binding-<platform>` packages. 64 Rust tests and 115 Node tests pass, and CI is
green across three operating systems by three Node majors.

**Verified from the registry on `darwin-arm64` only.** A clean install pulls four packages —
`os`/`cpu` gating picks one platform binding out of eight — and compiles a PDF with an embedded
font subset through both pools. The other seven platform packages are published and correctly
gated but have never been installed on their own platform.
See [`phase-4/00-publishing.md`](phase-4/00-publishing.md).

## Orientation

- [`PLAN.md`](PLAN.md) → [`plan/`](plan/) — the implementation plan, phased
- [`discovery/`](discovery/00-overview.md) — Phase 0 research findings with evidence
- [`phase-1/`](phase-1/00-overview.md) — the Rust core: architecture, API, findings
- [`phase-2/`](phase-2/00-overview.md) — the napi layer and the thread pool
- [`phase-3/`](phase-3/00-overview.md) — the TypeScript packages and the worker-process pool.
  **[`phase-3/05-handoff.md`](phase-3/05-handoff.md) is where to start if you are picking up
  Phase 4.**
- [`phase-4/00-publishing.md`](phase-4/00-publishing.md) — the first publish, and the six
  defects it cost. Read before touching `release.yml` or `scripts/initial-publish.sh`.
- [`phase-5/00-throughput.md`](phase-5/00-throughput.md) — the throughput discrepancy, resolved.
  **It retracts the 532 µs figure outright** and supersedes
  [`discovery/07-benchmarks.md`](discovery/07-benchmarks.md)'s absolute numbers.

**Read these before writing any code:**

- [`discovery/02-footguns.md`](discovery/02-footguns.md) — three process-global Typst behaviors
  that dictate the API shape and are painful to retrofit.
- [`discovery/08-phase-0-results.md`](discovery/08-phase-0-results.md) — measured Phase 0
  results. It **corrects several claims** in the earlier research documents; where they
  disagree, it wins.
- [`phase-2/03-findings.md`](phase-2/03-findings.md) — what Phase 2 measured. It **retracts hard
  rule 9 outright**, and redirects the multi-run throughput collapse from rayon to process
  isolation.
- [`phase-1/03-findings.md`](phase-1/03-findings.md) — what Phase 1 measured, including the
  font licensing correction behind rule 11.
- [`phase-3/03-findings.md`](phase-3/03-findings.md) — what Phase 3 measured. The
  worker-process pool is **6.9× faster than threads** on multi-run documents and **0.66×** on
  ordinary ones, and it documents two silent-failure modes in SVG text (rule 12).

## Packages

| Package | Purpose |
|---|---|
| `@emquad/core` | Main package: TS API, both pools, `EmquadError`. **Built** |
| `@emquad/fonts` | Optional default Typst fonts (9.3 MB; **four licenses, not just OFL** — see rule 11). **Built** |
| `@emquad/resolver` | `@preview` registry resolver (TS — owns all networking; zero runtime deps). **Built** |
| `@emquad/typst-binding` | The napi loader and generated declarations. Lives in `packages/binding`. **Published** |
| `@emquad/typst-binding-<platform>` | Prebuilt native bindings, one per target, under `packages/binding/npm/`. **Eight published** |

`packages/core/src/binding.ts` is the only file that imports `@emquad/typst-binding`.

> Renamed from `@emquad/binding` in Phase 4. The directory is still
> `packages/binding` — directory name and package name deliberately diverge, because the
> published name has to carry the `typst-binding` prefix that napi derives the eight platform
> package names from.

The loader resolves `@emquad/typst-binding-<platform>` at require time and falls back to a
`.node` beside itself, which is what makes local development work with no platform packages
installed. It stays `private` until those packages are published — see
[`phase-3/05-handoff.md`](phase-3/05-handoff.md) for why that ordering is forced rather than
chosen.

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
   **Phase 3 built that isolation.** `pool.timeoutMs` works by killing a worker *process*, so it
   is honest — and it exists **only** for `pool.mode: "process"`. Setting it in thread mode is a
   construction error, never a no-op, because an option that silently did nothing there is
   precisely what this rule forbids.

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

9. **~~Pin typst's internal rayon to 1 thread.~~ Retracted in Phase 2 — do not do this.**
   Phase 0 measured `RAYON_NUM_THREADS=1` as worth 29–43% on multi-page-run documents.
   Phase 2 measured our in-process equivalent under a real worker pool and found **no benefit
   at any pool size**, plus a ~15% cost at low concurrency. Pinning is now **off by default**.
   More importantly, it establishes that **rayon is not what makes multi-run documents
   collapse**: with typst confined to one rayon thread per worker, throughput still falls to
   0.45× at eight threads. The contention is process-global — most likely `comemo` — so the
   answer is the worker-*process* pool, not rayon tuning.
   See [`phase-2/03-findings.md`](phase-2/03-findings.md).

10. **Benchmarks that vary one option must use disjoint document ranges per configuration.**
    Otherwise whichever runs second harvests `comemo` hits from the first. This produced a
    completely wrong Q4 result before it was caught.

11. **Ship the default font files byte-for-byte.** They are *not* all OFL — the 17 files span
    four licenses, and `NewCM10-Regular.otf` is GPL-3.0-or-later. Its Distribution Exception
    is what lets an MIT package carry it, and that exception is void the moment glyphs are
    added, removed, or re-encoded. **Subsetting the fonts to shrink the 9.3 MB would
    relicense `@emquad/fonts` as GPL-3.** Drop whole families instead — `fontsExcept()` is
    there for that. Enforced by checksum in `packages/fonts/test/fonts.test.js`. See
    [`../LICENSING.md`](../LICENSING.md).

12. **SVG text in an unregistered font family fails silently — sometimes completely.**
    Typst emits **no diagnostic at all** for an SVG whose `font-family` is not registered: not
    an error, not a warning. With a serif family present the text is substituted; with only a
    monospace family registered the text **renders as nothing** — valid PDF, successful compile,
    zero warnings, no glyphs. This is hard rule 8's failure reachable with a font set that is
    merely *incomplete* rather than empty, and no check can catch it because typst reports
    nothing to catch. Ordinary `#set text(font: …)` does warn; SVG is not on that path.
    Register a serif family. Pinned by tests in `packages/core/test/golden.test.js`.
    See [`phase-3/03-findings.md`](phase-3/03-findings.md#3).

## Conventions

- **TypeScript everywhere, ESM-only.** No CJS build. Native addons cannot be `import`ed
  directly — build with `napi build --platform --esm`.
- **Node >= 22**, built against Node-API 9.
- **`tsdown` builds; `tsc` only type-checks.** `noEmit` is set workspace-wide. Bundlers are bad
  at type errors and `tsc` is slow at bundling; asking either to do the other's job gets the
  worst of both. `pnpm typecheck` is on pre-push, not pre-commit.
- **TypeScript 7** (the native compiler). `baseUrl` is removed — `paths` resolve relative to the
  tsconfig — and `types: ["node"]` must be explicit under pnpm's symlinked layout.
- **Internal imports use the `#/*` subpath alias**, declared in both `package.json` `imports`
  and tsconfig `paths`. They name `.ts` files directly.
- **turbo** orchestrates build/typecheck/test. `test` is uncached: the suites read fixtures
  turbo does not track.
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

This is not hypothetical, and it has now happened twice. Phase 0 found that an empty font set
produces a **blank PDF with zero diagnostics** and a successful compile. Phase 3 found that SVG
text in an unregistered family can vanish entirely, also with zero diagnostics (rule 12) — and
**only the rasterized golden-file tests caught it.** The compile succeeded, the PDF was valid,
the page count was right, and nothing was thrown.

Golden files live in `packages/core/test/golden/`. Regenerate with `UPDATE_GOLDENS=1`, never
automatically, and read the diff artifact in `test/golden/diff/` before you do.

## Key measured facts

Measured on Apple M1 (4 performance + 4 efficiency cores), Typst 0.15.1. Full context in
[`discovery/07-benchmarks.md`](discovery/07-benchmarks.md) and
[`discovery/08-phase-0-results.md`](discovery/08-phase-0-results.md).

| Metric | Value |
|---|---|
| Distinct documents (realistic) | **~705 µs → ~1,420 docs/sec/core** (engine, library defaults) |
| Cold first compile | 3.3 ms warm OS cache, 10.3 ms first ever (one-time per process) |
| Thread scaling, simple documents | 3.71× at 4 threads, flat after |
| Thread scaling, many page runs | **0.46×** — collapses; processes reach 5.18× |
| Process pool vs threads, many page runs (Phase 3) | **6.93× at 8**, 3.83× at 4 |
| Process pool vs threads, simple documents (Phase 3) | **0.66× at 8** — threads win |
| Process pool startup | 44–100 ms, against ~4 ms for threads |
| `evict(2)` / `evict(16)` overhead | −9.8% / **−5.9%** — both bound RSS to ~40 MB vs ~1 GB |
| `tagged: true` cost | +5–28% time, **up to +302% output size** |
| Binary size (shipping, fonts external) | 29.4 MB uncompressed / **12.8 MB gzipped** |
| Official `typst-cli`, same basis | 45.0 MB uncompressed — **we are ~13% smaller** |

npm ships gzipped tarballs and each user installs one platform package, so **~12.8 MB is the
real per-user download**. The typst releases page shows sub-20 MB assets, but those are
xz-compressed *archives* — do not compare them against an uncompressed `.node`.

Do not use `panic = "abort"` to shrink the binary: it disables `catch_unwind`, which hard
rule 2 depends on.

The ~705 µs figure is an **optimistic bound** — one synthetic invoice varying only a substituted
integer, on one machine. Re-measure with production templates before leaning on it. Never quote
the memoized ~332 µs number; it recompiles an identical document.

**The old 532 µs / 1,881 docs-per-sec figure is retracted.** The original Phase 0 binary,
rebuilt from its original source, measures 616 µs on the same hardware today. Absolute numbers
from different sessions were never comparable.

**`pool.mode` is a document-shape decision, not a performance dial.** A page *run* comes from
page re-configuration, not page count, so an ordinary document — even a 200-page report — has
exactly one and belongs on threads. Documents that repeatedly `#set page(...)` belong on
processes, as does anything compiling untrusted templates.

**A single-core throughput number is now publishable**, with its caveats attached — see
[`phase-5/00-throughput.md`](phase-5/00-throughput.md). The Phase 1 / Phase 0 discrepancy is
resolved as far as it needs to be: most of it was measurement error, not a real gap.

- The engine benchmark defaulted to **pinned rayon, which the library does not do** — worth
  ~5–7%, and now fixed to match `CompilerBuilder`'s default.
- **532 µs does not reproduce.** The original probe gives 616 µs today on the same machine.
- **Per-compile wrapper overhead is ~0%**, measured: with both harnesses given the same shape in
  one session, the memoized rows match within 0.4% (315.3 vs 316.5 µs). This **refutes** the
  standing suspect list — `catch_unwind`, interning, and settings conversion together cost
  about 1 µs.

~15.6% remains, inside compile work rather than around it, and is undiagnosed. It is an
optimization opportunity, not a defect. **The Puppeteer comparison is still unmeasured**, and
that is the number that actually drives adoption.
