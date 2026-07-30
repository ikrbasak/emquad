# Phase 1 — Rust Core. Complete.

`emquad-engine` compiles a Typst virtual filesystem to a PDF. Pure Rust, no napi
dependency, exercised entirely by `cargo test`.

**Status: complete.** 61 tests pass, clippy and rustfmt are clean, `cargo doc` has no warnings.
Phases 2 and 3 are complete as well.

Brief: [`../plan/02-phase-1-rust-core.md`](../plan/02-phase-1-rust-core.md). Everything in that
brief is delivered; the deviations from it are listed below and explained in
[`03-findings.md`](03-findings.md).

## Read these in order

| Document | What it answers |
|---|---|
| [`01-architecture.md`](01-architecture.md) | What each module is for and why it is shaped that way |
| [`02-api-guide.md`](02-api-guide.md) | How to use the crate, with working examples |
| [`03-findings.md`](03-findings.md) | **What Phase 1 measured and what it corrects.** Includes a correction to hard rule 9 |
| [`04-tooling.md`](04-tooling.md) | Formatting, linting, hooks, license compliance |
| [`05-handoff.md`](05-handoff.md) | The Phase 2 handoff. Phase 2 is done; [`../phase-3/05-handoff.md`](../phase-3/05-handoff.md) is the current one |

Before touching the code, read [`../discovery/02-footguns.md`](../discovery/02-footguns.md) and
[`../discovery/08-phase-0-results.md`](../discovery/08-phase-0-results.md). Three process-global
Typst behaviors dictate this API's shape and are painful to retrofit.

## What runs

```sh
cargo test                          # 61 tests, ~1s after the first build
cargo clippy --all-targets --all-features
cargo fmt --all -- --check

cargo bench --bench compile         # throughput; see 03-findings.md before quoting a number
cargo bench --bench soak            # RSS over a long run
./scripts/benchcmp.sh multirun      # pinned vs unpinned typst rayon, one config per process
./scripts/check-no-sys-crates.sh    # hard rule 4
cargo deny check licenses           # needs `cargo install cargo-deny --locked`
pnpm notices                        # regenerates THIRD-PARTY-NOTICES.md
```

The first build takes several minutes — 293 crates, and the release profile uses
`lto = true` with `codegen-units = 1`. Debug builds are fast after that.

## The shape of it

```
Cargo.toml                     workspace: lints, pinned typst =0.15.1, release profile
rust-toolchain.toml            1.97.1, pinned
crates/emquad-engine/
  src/
    lib.rs                     public surface, crate docs
    paths.rs        1.1        VfsPath + the FileId interning guard
    vfs.rs          1.2        Workspace (shared base) + Overlay (per compile)
    fonts.rs        1.3        FontRegistry; empty set is a hard error
    world.rs        1.4        the seven World methods, nothing else
    clock.rs        1.4        injectable clock, no timezone dependency
    diagnostics.rs  1.5        SourceDiagnostic -> Diagnostic with real positions
    pdf.rs          1.6        PdfSettings -> typst_pdf::PdfOptions, validated early
    compile.rs      1.7        Compiler + fluent Compile builder, catch_unwind
    cache.rs                   comemo eviction, with the Phase 0 numbers
    rayon.rs                   confining typst's rayon; read before changing pin_rayon
  tests/
    compile.rs                 17 end-to-end tests
    diagnostics.rs             8 position/hint/trace tests
    interner_guard.rs          the guard, in its own process
    common/mod.rs              fixtures: fonts, a PNG, an SVG, an invoice
  benches/
    compile.rs                 throughput, one configuration per process
    soak.rs                    RSS over 20k+ compiles
    fixtures.rs                the three reference documents
scripts/
  check-no-sys-crates.sh       hard rule 4, wired into pre-commit
  benchcmp.sh                  pinned vs unpinned, repeated with alternating order
```

Numbers in the second column are sections of the Phase 1 brief.

## Deviations from the brief

Four, all deliberate. Reasoning in [`03-findings.md`](03-findings.md).

1. **`compile()` returns `Result<CompileOutput, Error>`, not `Result<_, Vec<Diagnostic>>`.**
   A missing font set, an exhausted path vocabulary, and a caught panic are not diagnostics —
   they have no position and no severity. Forcing them into that shape would have meant
   inventing fake ones.
2. **`Diagnostic` carries `Option<Position>` rather than three parallel `Option` fields**, and
   hints carry their own positions. Typst 0.15 lets a hint point at different code than the
   error, and flattening that would have discarded information.
3. **`PdfSettings` rejects `tagged: true` combined with `page_ranges` before compiling.** Typst
   catches it at export, after the whole compile is paid for, and reports it with no position
   and no hint.
4. **Rayon pinning is configurable and its default is now contested.** See hard rule 9's
   correction in [`03-findings.md`](03-findings.md).

## What is not here

- **No napi, no threads, no process pool.** Phase 2.
- **No package fetching.** The engine stores package files it is handed; the resolver is
  TypeScript, in Phase 3. Networking staying out of Rust is what keeps the dependency tree
  free of `-sys` crates (hard rule 4).
- **No golden-file rendering tests.** Comparing rendered pages needs a rasterizer, which this
  crate deliberately does not have — PDF is the only export. Phase 2 does it from Node.
  Phase 1 uses the strongest dependency-free proxy available: asserting the PDF embeds a font.
  See [`../plan/07-testing-strategy.md`](../plan/07-testing-strategy.md).
