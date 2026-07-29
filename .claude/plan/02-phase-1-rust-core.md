# Phase 1 — Rust Core (`emquad-engine`)

> ## ✅ Complete
>
> Built and documented in [`../phase-1/`](../phase-1/00-overview.md). 61 tests pass; clippy,
> rustfmt, and rustdoc are clean.
>
> Everything in this brief is delivered. Four deliberate deviations, and what Phase 1 measured
> that **corrects hard rule 9 and the font licensing**, are in
> [`../phase-1/03-findings.md`](../phase-1/03-findings.md).
>
> The document below is the original brief, kept for context. Proceed to
> [Phase 2](03-phase-2-napi.md), starting with
> [`../phase-1/05-handoff.md`](../phase-1/05-handoff.md).

Pure Rust, **no napi dependency**. Testable with plain `cargo test`, and reusable for a wasm
or CLI target later without restructuring.

```toml
typst        = "=0.15.1"
typst-layout = "=0.15.1"   # PagedDocument is NOT re-exported by `typst`
typst-pdf    = "=0.15.1"
comemo       = "0.5"
```

Pin exact versions. See [`../discovery/01-typst-as-a-library.md`](../discovery/01-typst-as-a-library.md).

## 1.1 Path interning guard

**Do this first.** It is the highest-severity footgun and everything else depends on the path
model.

- Central `intern_path()` wrapper — the **only** place `FileId` is constructed.
- Maintain a count of interned paths; return a structured error well before 65,535 with an
  actionable message ("path vocabulary exhausted; are you generating unique filenames per
  render? see <link>") rather than letting `expect("out of file ids")` panic.
- Expose the count for metrics.
- Never use `FileId::new_fake` — it does not deduplicate and makes the leak worse.

## 1.2 Layered VFS

```rust
pub struct Workspace {          // long-lived, shared
    base: Arc<HashMap<FileId, Bytes>>,
}
pub struct Overlay {            // per compile, small
    files: HashMap<FileId, Bytes>,
}
```

- `World::file` resolves overlay → base → `NotFound`.
- Base layer is `Arc`-cloned per compile: cheap, immutable, no tearing under concurrency.
- Base holds shared templates, logos, and mounted `@preview` packages.
- Overlay holds `main.typ` and this request's data.

Design rationale in
[`../discovery/05-fonts-assets-charts.md`](../discovery/05-fonts-assets-charts.md). Keeping the
base stable is not just an optimization — rebuilding it invalidates the `comemo` memo cache.

## 1.3 Font registry

- Parse once via `Font::iter(Bytes)`; store `Vec<Font>` + `FontBook`.
- `Font` is cheaply cloneable — clone handles per compile, never re-parse.
- `font(index)` must tolerate **out-of-bounds indices** (documented upstream behavior during
  incremental compilation). Return `None`; never panic.
- Runtime font registration is supported but rebuilds the `FontBook` and invalidates the memo
  cache. Make the cost visible in the type signature — prefer returning a new handle over
  mutating in place.
- Handle variable-font family naming: 0.15 trims `Variable`/`Var`/`VF` suffixes.

## 1.4 `World` implementation

All seven methods. Small, isolated module — this is the entire blast radius of a typst upgrade.

- `today()` accepts an injected clock so output can be made reproducible and tests deterministic.
- `source()` decodes UTF-8 from the same byte store as `file()`.

## 1.5 Diagnostics

**This is the main differentiator over the existing binding. Over-invest here.**

Map `SourceDiagnostic` → a structured type:

```rust
pub struct Diagnostic {
    severity: Severity,        // error | warning
    message: String,
    file: Option<String>,      // VFS path, not FileId
    line: Option<u32>,         // 1-based
    column: Option<u32>,       // 1-based
    hints: Vec<String>,
    trace: Vec<TraceFrame>,
}
```

- Use `WorldExt::range(span)` for the byte range, then `Source` line/column mapping.
- Preserve `hints` — Typst's hints are genuinely good and the existing binding discards them.
- Surface **warnings on success too** (`compile` returns `Warned<T>`, so they survive).
- Include the trace for errors inside packages or nested imports.

## 1.6 PDF export

- Expose `PdfOptions`: `tagged`, `standards` (PDF/A, PDF/UA), `page_ranges`, `ident`,
  `timestamp`, `creator`, `pretty`.
- Keep `tagged: true` as upstream's default. Do not silently flip it for benchmark numbers —
  it is an accessibility regression users would not notice.
- Provide a documented "reproducible" preset pinning `today()`, `ident`, and `timestamp`.

## 1.7 Compile entry point

```rust
pub fn compile(world: &EmquadWorld, opts: &PdfOptions)
    -> Result<CompileOutput, Vec<Diagnostic>>;

pub struct CompileOutput {
    pdf: Vec<u8>,
    warnings: Vec<Diagnostic>,
    pages: usize,
}
```

Wrap in `catch_unwind` — a panic crossing into Node aborts the process.

## Deliverables

- `emquad-engine` compiling a realistic invoice (fonts, PNG, SVG, table, gradient) to PDF
- Path-interning guard with a test proving it errors before panicking
- Diagnostics with accurate line/column, covered by tests
- Benchmarks from Phase 0 promoted into `benches/`
- Unit and property tests per [07-testing-strategy.md](07-testing-strategy.md)
