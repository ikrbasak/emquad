# Discovery Overview

**Project:** `@emquad/core` — a lean Node.js binding for [Typst](https://github.com/typst/typst) that does one job well: VFS in → PDF out.

**Date of investigation:** 2026-07-29
**Typst version investigated:** 0.15.1 (released 2026-07-17, Apache-2.0)

## Why this project exists

Most Node backends generate PDFs with Chromium + Puppeteer. That is heavy (a whole browser),
slow, and memory-hungry. Typst is a markup-based typesetting system that is dramatically
lighter and faster. [Zerodha's write-up](https://zerodha.tech/blog/1-5-million-pdfs-in-25-minutes/)
(1.5M PDFs in 25 minutes) is the proof point that motivated this.

The existing binding, [`@myriaddreamin/typst-ts-node-compiler`](https://www.npmjs.com/package/@myriaddreamin/typst-ts-node-compiler),
does far more than we need. We want a narrow, fast, reliable package:

- Operates over a **virtual filesystem** (no workspace pollution)
- **Custom fonts** and binary assets
- **PDF only** — no SVG/PNG/HTML export
- Per-os/arch prebuilt native bindings, no postinstall download
- Fluent, well-typed TypeScript API

## Verdict: the premise holds

The investigation validated the core idea, with real numbers:

| Question | Finding |
|---|---|
| Is embedding Typst realistic? | **Yes.** The `World` trait is only **7 methods**. |
| Is the dependency tree cross-compile friendly? | **Yes**, except Windows — all 14 targets verified in Phase 0. |
| How big is the native binary? | **29.4 MB** shipping / **12.8 MB gzipped**; ~13% smaller than `typst-cli`. |
| Is it fast? | Yes — ~1,881 docs/sec/core. See [07-benchmarks.md](07-benchmarks.md). |

The zero-`-sys`-crate property is the single most valuable structural fact we found. It is
what makes a wide os/arch matrix affordable. **Protect it** — see
[04-packages-and-network.md](04-packages-and-network.md) for the main threat to it.

## But there are four serious footguns

The first three are documented in full in [02-footguns.md](02-footguns.md); the fourth was found
in [Phase 0](08-phase-0-results.md). Summarized:

1. **`FileId` is a leaky, capped, process-global interner.** Hard panic at exactly 65,535 unique
   paths, and entries are never freed. This is a crash-in-production risk and it dictates
   the VFS API design.
2. **`comemo`'s memo cache is process-global and grows unbounded** unless `evict()` is called.
   Measured: ~40 MB with eviction, ~1 GB without.
3. **There is no cancellation or timeout API.** A runaway template cannot be stopped from JS.
   Typst does guard `while` loops and recursion — but **not `for` loops**, which is the real hole.
4. **An empty font set produces a valid, blank PDF with zero diagnostics.** The compile
   *succeeds*. This is the silent-wrong-output failure mode in its purest form.

None of these are dealbreakers, but all four must be designed for up front rather than
patched later.

## Decisions taken

All confirmed by Phase 0; one amended.

| Area | Decision |
|---|---|
| Fonts | Separate optional package (`@emquad/fonts`), not embedded |
| Typst packages (`@preview/…`) | Network access **enabled**, implemented in the **TypeScript layer** |
| Concurrency | Dedicated Rust thread pool (async) **plus** `compileSync()` — **and a worker-process pool** ⚠ |
| Target matrix | Wide native matrix + `wasm32-wasip1-threads` universal fallback |
| Distribution | napi-rs prebuilds via `optionalDependencies`, no postinstall |
| Monorepo | pnpm + turbo |

⚠ The process pool is the one amendment: threads collapse to **0.46×** on documents with many
page runs, where separate processes scale to **5.18×**. See
[08-phase-0-results.md](08-phase-0-results.md#q3--throughput-vs-pool-size-).

## Document index

| File | Contents |
|---|---|
| [01-typst-as-a-library.md](01-typst-as-a-library.md) | The `World` trait, compile API, crate layout, version churn |
| [02-footguns.md](02-footguns.md) | **Read this one.** The three serious constraints, with source evidence |
| [03-concurrency.md](03-concurrency.md) | Threading model analysis and recommendation |
| [04-packages-and-network.md](04-packages-and-network.md) | Registry protocol, why network belongs in JS, the sync-World problem |
| [05-fonts-assets-charts.md](05-fonts-assets-charts.md) | Fonts, images, tables, and how charts actually work |
| [06-distribution.md](06-distribution.md) | napi-rs, target matrix, package naming |
| [07-benchmarks.md](07-benchmarks.md) | Measured numbers and honest methodology notes |
| [08-phase-0-results.md](08-phase-0-results.md) | **Phase 0 gate results.** Corrects several claims above — where they disagree, this one wins |

The implementation plan lives in [`../PLAN.md`](../PLAN.md).
