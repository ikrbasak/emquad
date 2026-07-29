//! Reference documents, promoted from the Phase 0 spike.
//!
//! Shared by every bench via `#[path = "fixtures.rs"] mod fixtures;`.
//!
//! **Benchmarks that vary one option must use disjoint document ranges per
//! configuration** (hard rule 10). Every generator here takes an `n` that is
//! substituted into the source, so callers can give each configuration its own
//! range. Sharing a range lets whichever configuration runs second harvest
//! `comemo` hits from the first; that produced a completely wrong `tagged`
//! result in Phase 0 (+139% against a true +5%) before it was caught.

#![allow(dead_code)]

use emquad_engine::{Compiler, FontRegistry, FontRegistryBuilder};

/// An invoice: color, a table with a per-row fill callback, and a gradient.
/// One page, one page run — the target workload.
pub const INVOICE: &str = r##"
#set page(width: 210mm, height: 297mm, margin: 20mm)
#set text(fill: rgb("#1a3a5a"))
= Invoice {N}
#table(
  columns: 3, stroke: 0.5pt + rgb("#888888"),
  fill: (_, y) => if y == 0 { rgb("#eeeeff") },
  table.header([*Item*], [*Qty*], [*Price*]),
  [Widget], [{N}], [$12.00$], [Gadget], [7], [$45.50$],
)
#rect(fill: gradient.linear(rgb("#ff0000"), rgb("#0000ff")), width: 100%, height: 2cm)
"##;

/// A content-heavy report. Many pages, but still a single page run.
pub const REPORT: &str = r##"
#set page(width: 210mm, height: 297mm, margin: 20mm)
#set text(fill: rgb("#1a3a5a"))
= Report {N}
#for i in range(60) [
  == Section {N}-#i
  #lorem(40)
  #table(
    columns: 3, stroke: 0.5pt + rgb("#888888"),
    fill: (_, y) => if y == 0 { rgb("#eeeeff") },
    table.header([*Item*], [*Qty*], [*Price*]),
    [Widget], [#i], [$12.00$], [Gadget], [7], [$45.50$],
  )
  #rect(fill: gradient.linear(rgb("#ff0000"), rgb("#0000ff")), width: 100%, height: 1cm)
]
"##;

/// Forty page *runs*. `typst-layout` parallelizes over runs, which are created
/// by page re-configuration rather than by page count — an ordinary document
/// has exactly one. This is the only shape that exercises typst's internal
/// rayon usage, and the shape where thread scaling collapsed in Phase 0.
pub const MULTIRUN: &str = r##"
= Multi-run {N}
#for i in range(40) [
  #set page(width: 210mm, height: 297mm, margin: (x: 20mm + i * 0.1mm, y: 20mm))
  == Run {N}-#i
  #lorem(60)
]
"##;

pub fn invoice(n: usize) -> String {
    INVOICE.replace("{N}", &n.to_string())
}

pub fn report(n: usize) -> String {
    REPORT.replace("{N}", &n.to_string())
}

pub fn multirun(n: usize) -> String {
    MULTIRUN.replace("{N}", &n.to_string())
}

/// Select a document by name, for `EMQUAD_DOC=invoice|report|multirun`.
pub fn document(name: &str, n: usize) -> String {
    match name {
        "report" => report(n),
        "multirun" => multirun(n),
        _ => invoice(n),
    }
}

pub fn doc_name() -> String {
    std::env::var("EMQUAD_DOC").unwrap_or_else(|_| "invoice".to_owned())
}

/// The default typst fonts, parsed once.
pub fn fonts() -> FontRegistry {
    let mut builder = FontRegistryBuilder::new();
    for data in typst_assets::fonts() {
        builder.add(data);
    }
    builder.build().expect("typst-assets ships fonts")
}

pub fn compiler() -> Compiler {
    fonts_into(Compiler::builder()).build().expect("typst-assets ships fonts")
}

/// A compiler that leaves typst's rayon usage on whatever pool the calling
/// thread already has, for measuring what hard rule 9 actually buys.
pub fn compiler_unpinned() -> Compiler {
    fonts_into(Compiler::builder()).pin_rayon(false).build().expect("typst-assets ships fonts")
}

fn fonts_into(mut builder: emquad_engine::CompilerBuilder) -> emquad_engine::CompilerBuilder {
    for data in typst_assets::fonts() {
        builder = builder.font(data);
    }
    builder
}

/// Resident set size in KiB, via `ps`. Good enough for sampling a curve, and
/// avoids a dependency for something only benches use.
#[cfg(unix)]
pub fn rss_kib() -> u64 {
    let pid = std::process::id();
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .expect("ps failed");
    String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0)
}

#[cfg(not(unix))]
pub fn rss_kib() -> u64 {
    0
}
