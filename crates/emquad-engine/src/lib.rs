//! `emquad-engine` — the Typst compilation core behind `@emquad/core`.
//!
//! **VFS in → PDF out.** No filesystem access, no networking, no napi
//! dependency: this crate is exercised by plain `cargo test` and is reusable
//! from a wasm or CLI target without restructuring.
//!
//! ```no_run
//! use emquad_engine::Compiler;
//!
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! let compiler = Compiler::builder()
//!     .font(std::fs::read("Inter.ttf")?)
//!     .source("/templates/invoice.typ", "#let invoice(n) = [Invoice #n]")
//!     .build()?;
//!
//! let output = compiler
//!     .compile()
//!     .main_source(r#"#import "/templates/invoice.typ": invoice
//! #invoice(42)"#)
//!     .run()?;
//!
//! assert!(output.pages >= 1);
//! # Ok(())
//! # }
//! ```
//!
//! # Three things that will bite you
//!
//! Typst carries process-global state, and all three of the following are
//! painful to retrofit. They shape this API rather than hiding behind it.
//!
//! 1. **VFS paths are interned forever and capped at 65,535.** Vary file
//!    *content*, never file *paths*. Naming a file per request
//!    (`invoice-${uuid}.typ`) leaks permanently and crashes the process at ~65k
//!    renders; [`paths`] guards against it and names the offending pattern.
//! 2. **The memo cache is global and unbounded.** See [`cache`].
//! 3. **There is no way to cancel a compile.** Typst has no cancellation hook
//!    and a Rust thread cannot be forcibly killed, so there is deliberately no
//!    `timeout` option — it would leak a wedged thread while looking like
//!    protection. Untrusted templates need *process* isolation.
//!
//! And one that is worse because it is silent: **an empty font set compiles
//! successfully to a valid PDF with every text run dropped and zero
//! diagnostics.** [`FontRegistryBuilder::build`] rejects it.

// The pure core never needs `unsafe`, and this is stronger than the workspace's
// `deny`: nothing here, not even a macro, can opt back in.
#![forbid(unsafe_code)]

pub mod cache;
pub mod clock;
mod compile;
pub mod diagnostics;
mod error;
mod fonts;
pub mod paths;
mod pdf;
/// Documentation only — no public items. Read it before changing
/// [`CompilerBuilder::pin_rayon`].
pub mod rayon;
mod vfs;
mod world;

pub use compile::{Compile, CompileOutput, Compiler, CompilerBuilder, DEFAULT_MAIN};
pub use error::{Error, Result};
pub use fonts::{FontRegistry, FontRegistryBuilder};
pub use pdf::{Creator, PageRange, PdfSettings, PdfStandard, PdfTimestamp};
pub use vfs::{Overlay, Workspace, WorkspaceBuilder};

pub use clock::Clock;
pub use diagnostics::{Diagnostic, Hint, Position, Severity, TraceFrame};
pub use paths::VfsPath;

/// The exact Typst version this crate is built against.
///
/// Typst is pre-1.0 and breaks across minor releases, so the dependency is
/// pinned (hard rule 5). This constant exists so the version can be reported
/// through the napi layer without a second source of truth.
pub const TYPST_VERSION: &str = "0.15.1";
