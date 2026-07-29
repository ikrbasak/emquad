//! Does SVG text silently disappear? If so, Phase 1 must emit a real
//! diagnostic — a valid-but-wrong PDF is the failure mode this project
//! most needs to defend against.
//!
//! Method: render an SVG containing a <text> element, then the same SVG with
//! the text removed. If the two PDFs are the same size, the text contributed
//! nothing and was dropped.

use phase0::{vfs_id, VfsWorld};
use typst::foundations::Bytes;
use typst_layout::PagedDocument;

const SVG_WITH_TEXT: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
  <rect x="0" y="0" width="200" height="100" fill="#eeeeff"/>
  <text x="10" y="50" font-family="DejaVu Sans" font-size="20" fill="#1a3a5a">Hello SVG</text>
</svg>"##;

const SVG_NO_TEXT: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
  <rect x="0" y="0" width="200" height="100" fill="#eeeeff"/>
</svg>"##;

const DOC: &str = r##"
#set page(width: 100mm, height: 60mm, margin: 5mm)
#image("chart.svg", width: 80mm)
"##;

/// The unknown-font case: an SVG naming a family nobody registered.
const SVG_UNKNOWN_FONT: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
  <rect x="0" y="0" width="200" height="100" fill="#eeeeff"/>
  <text x="10" y="50" font-family="NoSuchFontFamily" font-size="20" fill="#1a3a5a">Hello SVG</text>
</svg>"##;

/// Also render body text, so we can compare how the two paths report failure.
const DOC_WITH_BODY_TEXT: &str = r##"
#set page(width: 100mm, height: 60mm, margin: 5mm)
Body text here.
#image("chart.svg", width: 80mm)
"##;

fn render_with(svg: &str, label: &str, doc: &str, fonts: bool) -> usize {
    let mut world = VfsWorld::new();
    if !fonts {
        // Simulates a user who never installed `@emquad/fonts`.
        world.fonts.clear();
        world.book = typst::utils::LazyHash::new(typst::text::FontBook::new());
    }
    world.set_main_source(doc);
    world
        .files
        .insert(vfs_id("chart.svg"), Bytes::new(svg.as_bytes().to_vec()));

    let result = typst::compile::<PagedDocument>(&world);
    for w in result.warnings.iter() {
        println!("  [{label}] WARNING: {}", w.message);
    }
    match result.output {
        Ok(doc) => {
            let pdf = typst_pdf::pdf(&doc, &typst_pdf::PdfOptions::default()).unwrap();
            println!("  [{label}] ok, pdf_bytes={}", pdf.len());
            pdf.len()
        }
        Err(diags) => {
            for d in diags.iter().take(3) {
                println!("  [{label}] ERROR: {}", d.message);
            }
            0
        }
    }
}

fn render(svg: &str, label: &str) -> usize {
    let mut world = VfsWorld::new();
    world.set_main_source(DOC);
    world
        .files
        .insert(vfs_id("chart.svg"), Bytes::new(svg.as_bytes().to_vec()));

    let result = typst::compile::<PagedDocument>(&world);
    for w in result.warnings.iter() {
        println!("  [{label}] WARNING: {}", w.message);
    }
    match result.output {
        Ok(doc) => {
            let pdf = typst_pdf::pdf(&doc, &typst_pdf::PdfOptions::default()).unwrap();
            println!("  [{label}] ok, pdf_bytes={}", pdf.len());
            pdf.len()
        }
        Err(diags) => {
            for d in diags.iter() {
                println!("  [{label}] ERROR: {}", d.message);
            }
            0
        }
    }
}

fn main() {
    println!("== SVG containing <text>, fonts registered in the World ==");
    let with_text = render(SVG_WITH_TEXT, "with-text");
    println!("== identical SVG, <text> element removed ==");
    let no_text = render(SVG_NO_TEXT, "no-text");

    println!();
    if with_text == 0 || no_text == 0 {
        println!("VERDICT: compile failed — see errors above");
    } else if with_text == no_text {
        println!(
            "VERDICT: SVG TEXT SILENTLY DROPPED — both PDFs are {with_text} bytes, \
             and no warning was emitted."
        );
        println!("         Phase 1 must detect and report this.");
    } else {
        println!(
            "VERDICT: SVG text was rendered ({with_text} vs {no_text} bytes, \
             delta {} bytes).",
            with_text as i64 - no_text as i64
        );
    }

    println!("\n== SVG naming a font family nobody registered ==");
    let unknown = render_with(SVG_UNKNOWN_FONT, "unknown-font", DOC, true);
    println!(
        "VERDICT: {}",
        if unknown == no_text {
            "DROPPED SILENTLY (same size as the text-free SVG)".to_string()
        } else {
            format!("substituted a fallback font ({unknown} vs {no_text} bytes)")
        }
    );

    println!("\n== no fonts registered at all (user skipped @emquad/fonts) ==");
    println!("-- SVG text --");
    let svg_nofonts = render_with(SVG_WITH_TEXT, "svg-nofonts", DOC, false);
    println!("-- body text, same empty FontBook --");
    let body_nofonts = render_with(SVG_WITH_TEXT, "body-nofonts", DOC_WITH_BODY_TEXT, false);
    println!(
        "VERDICT: svg-only={} body+svg={} -> {}",
        svg_nofonts,
        body_nofonts,
        if svg_nofonts > 0 && body_nofonts == 0 {
            "ASYMMETRIC: body text errors loudly, SVG text does not"
        } else if svg_nofonts > 0 && body_nofonts > 0 {
            "both compile — check warnings above for whether anything was reported"
        } else {
            "both fail"
        }
    );
}
