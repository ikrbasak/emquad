# Testing Strategy

Testing runs throughout, not as a phase. The load-bearing principle: **PDF generation fails
silently far more often than it crashes.** A missing glyph, a dropped SVG text run, or a
subtly different layout all produce a valid PDF that is simply wrong. Tests that only assert
"no error thrown" would pass through most of the bugs that matter here.

## Layers

### 1. Rust unit tests (`emquad-engine`)

Plain `cargo test`, no Node involved — this is why the core crate has no napi dependency.

- **VFS layering** — overlay shadows base; base untouched by overlay writes; missing file
  yields `NotFound`, not a panic.
- **Path interning guard** — errors with our actionable message *before* Typst's
  `expect("out of file ids")` panics. Assert the error, not the panic.
- **Font registry** — `font(index)` with out-of-bounds indices returns `None` (documented
  upstream behavior during incremental compilation); variable-font suffix trimming.
- **Diagnostics** — line/column mapping is exact. Table-driven: source with a known-bad token
  at a known position → assert precise line and column. Include errors inside imported files
  so `trace` is covered.
- **Determinism** — same input plus pinned clock/`ident`/`timestamp` produces byte-identical
  PDFs.

### 2. Golden-file (snapshot) tests

The primary defense against silent-wrong-output.

- A corpus of `.typ` fixtures covering tables (including header repetition across pages),
  images (PNG/JPEG/SVG), colors and gradients, custom fonts, multi-page flow, and `@preview`
  package usage.
- **Do not snapshot raw PDF bytes** — they shift with every Typst release and produce
  unreviewable diffs. Instead assert on **rendered page images** with a perceptual-difference
  threshold, plus extracted text content and page count.
- Store reference renders in-repo. On mismatch, emit a visual diff artifact in CI so a human
  can judge intent versus regression.
- Regenerating goldens must be an explicit, reviewed action — never automatic.

**Explicitly cover the silent-failure cases:**
- SVG referencing an unregistered font — assert we emit a diagnostic rather than silently
  dropping glyphs.
- A document requesting an unavailable font family.

### 3. Property tests

- **VFS**: arbitrary overlay/base combinations always resolve to overlay-wins.
- **Path handling**: arbitrary path strings never panic; invalid ones produce structured errors.
- **Diagnostics**: for any byte offset in any source, line/column mapping stays in bounds and
  round-trips.

### 4. Concurrency and memory tests

Directly targets [footguns #1 and #2](../discovery/02-footguns.md).

- **Determinism under parallelism** — N concurrent compiles produce output byte-identical to
  running them serially. This is where snapshot-isolation bugs would hide.
- **Soak test** — 100k+ distinct compiles with RSS sampling; assert memory plateaus with
  eviction on. Long-running, so nightly rather than per-PR.
- **Interner pressure** — approach the 65,535 path limit and assert a clean error.
- **Cache behavior** — verify `evict` actually bounds the `comemo` cache, and that two
  `Compiler` instances behave sanely given the cache is process-global.

### 5. Node integration tests

- `Compiler` lifecycle, async and sync paths, structured errors reaching JS with correct
  `file`/`line`/`column`/`hints`.
- **Panics do not abort the process** — deliberately trigger a Rust panic and assert it
  surfaces as a catchable JS error.
- Zero-copy buffer output is correct and not truncated.
- Backpressure: queue bounds behave as configured under saturation.

### 6. Resolver tests

- Fully mocked registry — no network in unit tests.
- Cache tiers: memory hit, disk hit, network fetch. **Assert network is hit exactly once per
  version, never per compile** — this is the core correctness claim of the caching design.
- Transitive dependency resolution through the compile–fetch–retry loop.
- `offline` mode fails cleanly on a cache miss.
- Lockfile integrity mismatch is rejected, including on disk-cache reads.
- One opt-in test hitting the real registry, excluded from default CI runs.

### 7. Packaging tests

- **Clean-consumer ESM smoke test**: a fresh project with `"type": "module"` installs the
  packed tarball and runs `import { Compiler } from '@emquad/core'`. Catches loader and
  `exports`-map regressions that nothing else does.
- Each platform package installs and loads on its target — run on the real matrix in CI.
- Verify `optionalDependencies` resolution skips incompatible platforms rather than failing.

## CI shape

| Stage | Runs |
|---|---|
| Per PR | Rust unit + property, golden files, Node integration, resolver (mocked), ESM smoke |
| Per PR (matrix) | Build + load test on every target |
| Nightly | Soak/memory, interner pressure, real-registry test, benchmark regression |
| Release | Full matrix build, packaging tests, provenance |

## Benchmarks as tests

Promote the Phase 0 harness into `crates/emquad-engine/benches/` and track results over time.
Fail CI on a significant regression. Given that throughput is the entire value proposition
versus Puppeteer, a silent 3× slowdown is a defect as serious as a wrong-output bug.
