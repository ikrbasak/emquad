//! Shared fixtures for the integration tests.
//!
//! Each test binary compiles this module separately and uses only part of it,
//! so unused items here are expected rather than dead.

#![allow(dead_code)]

use emquad_engine::{Compiler, CompilerBuilder};

/// A builder with the default typst fonts registered.
pub fn builder() -> CompilerBuilder {
    let mut builder = Compiler::builder();
    for data in typst_assets::fonts() {
        builder = builder.font(data);
    }
    builder
}

pub fn compiler() -> Compiler {
    builder().build().expect("typst-assets ships fonts")
}

/// A 1×1 transparent PNG — the smallest thing that proves image decoding ran.
pub const PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // signature
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15,
    0xC4, 0x89, //
    0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, // IDAT
    0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, //
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82, // IEND
];

pub const SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20">
  <rect width="40" height="20" fill="#1a3a5a"/>
  <circle cx="10" cy="10" r="6" fill="#ffcc00"/>
</svg>"##;

/// The manifest every mounted `@preview` package needs. Typst reads it to find
/// the entrypoint, and an import fails without it.
pub const MANIFEST: &str = r#"[package]
name = "example"
version = "0.1.0"
entrypoint = "lib.typ"
"#;

/// An invoice exercising everything Phase 1 promises: custom fonts, a raster
/// image, an SVG, a table with a per-row fill callback, colors, and a gradient.
pub const INVOICE: &str = r##"
#set page(width: 210mm, height: 297mm, margin: 20mm)
#set text(fill: rgb("#1a3a5a"))

= Invoice #context counter(page).display()

#image("/assets/logo.png", width: 12pt)
#image("/assets/mark.svg", width: 40pt)

#table(
  columns: 3,
  stroke: 0.5pt + rgb("#888888"),
  fill: (_, y) => if y == 0 { rgb("#eeeeff") },
  table.header([*Item*], [*Qty*], [*Price*]),
  [Widget], [3], [$12.00$],
  [Gadget], [7], [$45.50$],
)

#rect(fill: gradient.linear(rgb("#ff0000"), rgb("#0000ff")), width: 100%, height: 2cm)
"##;

/// Does the PDF embed at least one font?
///
/// This is the dependency-free proxy for the failure mode that matters most:
/// typst compiles happily with no fonts and emits a valid PDF with every text
/// run silently dropped. A PDF with no `/Font` resource is that blank page.
pub fn embeds_a_font(pdf: &[u8]) -> bool {
    contains(pdf, b"/Font")
}

pub fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|window| window == needle)
}
