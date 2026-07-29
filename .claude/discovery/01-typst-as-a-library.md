# Typst as an Embedded Library

All signatures below were read from the actual 0.15.1 sources in the local Cargo registry,
not from documentation or memory.

## The `World` trait — only 7 methods

This is the entire interface between Typst and its host environment
(`typst-library-0.15.1/src/lib.rs:60`):

```rust
pub trait World: Send + Sync {
    fn library(&self) -> &LazyHash<Library>;
    fn book(&self) -> &LazyHash<FontBook>;
    fn main(&self) -> FileId;
    fn source(&self, id: FileId) -> FileResult<Source>;
    fn file(&self, id: FileId) -> FileResult<Bytes>;
    fn font(&self, index: usize) -> Option<Font>;
    fn today(&self, offset: Option<Duration>) -> Option<Datetime>;
}
```

Two things follow from this:

- A VFS-backed implementation is genuinely small. This validates the whole project premise.
- **`Send + Sync` is required**, so the world must be safe to share across threads. Our design
  uses an immutable `Arc` snapshot per compile.

Note `font(index)` is documented as possibly being called with **out-of-bounds indices** from
a stale font book during incremental compilation. Return `None`, never panic.

## Compile pipeline

```rust
// typst-0.15.1/src/lib.rs:74
pub fn compile<T>(world: &dyn World) -> Warned<SourceResult<T>>

// typst-pdf-0.15.1/src/lib.rs:36
pub fn pdf(document: &PagedDocument, options: &PdfOptions) -> SourceResult<Vec<u8>>
```

`Warned<T>` carries warnings alongside the result, so warnings survive even on success —
worth surfacing in the JS API rather than discarding.

PDF generation is delegated to [`krilla`](https://crates.io/crates/krilla).

## Crate layout gotcha

`typst` re-exports only three things:

```rust
pub use typst_library::*;
pub use typst_syntax as syntax;
pub use typst_utils as utils;
```

**`PagedDocument` lives in `typst-layout` and is NOT re-exported.** You must add
`typst-layout` as a direct dependency. Likewise `typst-pdf`. So the real dependency set is:

```toml
typst        = "=0.15.1"
typst-layout = "=0.15.1"   # PagedDocument
typst-pdf    = "=0.15.1"
comemo       = "0.5"
```

`LibraryExt` (which provides `Library::default()` and `Library::builder()`) is defined in the
`typst` crate itself, not `typst-library`. Because `default()` is a trait method with the same
name as `Default::default`, you may need `<Library as LibraryExt>::default()` to disambiguate.

## Constructing `FileId` (changed in 0.15)

```rust
FileId::new(RootedPath::new(VirtualRoot::Project, VirtualPath::new("main.typ")?))
```

- `VirtualRoot` is `Project` or `Package(PackageSpec)` — package mounting falls naturally out
  of the same map, no separate code path needed.
- `VirtualPath::new` returns `Result<Self, PathError>`.

**Read [02-footguns.md](02-footguns.md) before designing anything that creates `FileId`s.**

## Version churn is the main maintenance cost

Typst is pre-1.0 and breaks across minor releases. Observed between 0.14 and 0.15:

- `FileId::new` changed from `(Option<PackageSpec>, VirtualPath)` to `(RootedPath)`, with the
  new `VirtualRoot` enum.
- `VirtualPath::new` now returns `Result`.
- `typst-kit` was "completely reworked" (per the 0.15.0 changelog).

Every one of these lands squarely in the small surface we must implement.

**Mitigations:**

1. **Pin exact versions** (`=0.15.1`), never a caret range.
2. **Do not depend on `typst-kit`.** We don't need it (see
   [04-packages-and-network.md](04-packages-and-network.md)), and skipping it removes a
   large, actively-churning surface *and* the entire HTTP/TLS dependency stack.
3. Keep the `World` impl isolated in one small module so a typst bump has a bounded blast radius.
4. Treat a typst minor bump as a minor bump of our own package.

## Dependency tree health

```
284 crates total
0   -sys crates
0   OpenSSL / bindgen / cmake
1   crate needing a C/asm toolchain: psm (via stacker), pulled by typst-eval
```

`stacker` is used by the recursive evaluator to grow the stack on demand. It is the only
component with per-architecture assembly, and therefore the most likely thing to block an
exotic target. See [06-distribution.md](06-distribution.md).

Everything else is pure Rust. **This is the property that makes the wide target matrix
affordable — guard it in code review.**
