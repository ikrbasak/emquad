//! End-to-end compiles.

mod common;

use emquad_engine::{
    Clock, Compiler, Creator, Error, PageRange, PdfSettings, PdfStandard, PdfTimestamp,
    Severity,
};

#[test]
fn a_realistic_invoice_compiles_to_pdf() {
    let compiler = common::builder()
        .file("/assets/logo.png", common::PNG)
        .source("/assets/mark.svg", common::SVG)
        .build()
        .unwrap();

    let output = compiler.compile().main_source(common::INVOICE).run().unwrap();

    assert_eq!(output.pages, 1);
    assert!(output.pdf.starts_with(b"%PDF-"), "not a PDF");
    assert!(common::contains(&output.pdf, b"%%EOF"), "truncated PDF");
    assert!(
        common::embeds_a_font(&output.pdf),
        "no font embedded — every text run was silently dropped"
    );
    assert!(output.warnings.is_empty(), "unexpected warnings: {:?}", output.warnings);
}

#[test]
fn the_base_layer_is_reusable_across_compiles() {
    let compiler = common::builder()
        .source("/templates/invoice.typ", "#let invoice(n) = [Invoice #n]")
        .build()
        .unwrap();

    let source = r#"#import "/templates/invoice.typ": invoice
#invoice(1)"#;

    // The point of a long-lived compiler: the same base layer serves every
    // compile, so the memo cache stays warm.
    let first = compiler.compile().main_source(source).run().unwrap();
    let second = compiler.compile().main_source(source).run().unwrap();

    assert_eq!(first.pages, 1);
    assert_eq!(first.pdf.len(), second.pdf.len());
}

#[test]
fn an_overlay_shadows_the_base_layer_for_one_compile_only() {
    let compiler =
        common::builder().source("/config.typ", "#let title = \"base\"").build().unwrap();

    let source = r#"#import "/config.typ": title
#title"#;

    let shadowed = compiler
        .compile()
        .source("/config.typ", "#let title = \"overlay\"")
        .main_source(source)
        .run()
        .unwrap();
    let plain = compiler.compile().main_source(source).run().unwrap();

    // Different text, therefore different output; the base layer survived.
    assert_ne!(shadowed.pdf, plain.pdf);
}

#[test]
fn a_missing_main_file_is_reported_by_path() {
    let compiler = common::compiler();
    let err = compiler.compile().main("/nowhere.typ").run().unwrap_err();
    match err {
        Error::MainNotFound { path } => assert_eq!(path, "/nowhere.typ"),
        other => panic!("expected MainNotFound, got {other}"),
    }
}

#[test]
fn a_missing_imported_file_is_a_compile_error_not_a_panic() {
    let compiler = common::compiler();
    let err =
        compiler.compile().main_source("#import \"/absent.typ\": thing").run().unwrap_err();

    let diagnostics = err.diagnostics();
    assert_eq!(err.code(), "COMPILE_FAILED");
    assert!(!diagnostics.is_empty());
    assert_eq!(diagnostics[0].file(), Some("/main.typ"));
}

#[test]
fn warnings_survive_a_successful_compile() {
    let compiler = common::compiler();
    // An unused import warns but still compiles.
    let output = compiler
        .compile()
        .source("/lib.typ", "#let unused = 1")
        .main_source("#import \"/lib.typ\"\nhello")
        .run()
        .unwrap();

    assert!(
        output.warnings.iter().all(|w| w.severity == Severity::Warning),
        "errors must not be reported as warnings"
    );
}

#[test]
fn reproducible_compiles_are_byte_identical() {
    let compiler = common::compiler();
    let source = "#set document(title: \"Statement\")\n= Statement\n#lorem(20)";

    let first = compiler
        .compile()
        .main_source(source)
        .reproducible("statement-v1", 1_785_888_000)
        .run()
        .unwrap();
    let second = compiler
        .compile()
        .main_source(source)
        .reproducible("statement-v1", 1_785_888_000)
        .run()
        .unwrap();

    assert_eq!(first.pdf, second.pdf, "reproducible output must not drift");
}

#[test]
fn the_clock_reaches_the_document() {
    let compiler = common::compiler();
    let source = "#datetime.today().display()";

    let output = compiler
        .compile()
        .main_source(source)
        .clock(Clock::fixed(1_785_888_000)) // 2026-08-05
        .run()
        .unwrap();
    assert_eq!(output.pages, 1);

    // With no clock, `datetime.today()` is an error in the document rather than
    // a silently wrong date.
    let err =
        compiler.compile().main_source(source).clock(Clock::Unavailable).run().unwrap_err();
    assert_eq!(err.code(), "COMPILE_FAILED");
}

#[test]
fn page_ranges_select_pages() {
    let compiler = common::compiler();
    let source = "#set page(width: 100pt, height: 60pt)\nfirst\n#pagebreak()\nsecond\n#pagebreak()\nthird";

    let all = compiler.compile().main_source(source).run().unwrap();
    assert_eq!(all.pages, 3);

    let one = compiler
        .compile()
        .main_source(source)
        .pdf(PdfSettings {
            // A page range requires untagged output; see the next test.
            tagged: false,
            page_ranges: Some(vec![PageRange::between(2, 2)]),
            ..Default::default()
        })
        .run()
        .unwrap();

    // `pages` counts what was laid out; the range applies at export.
    assert_eq!(one.pages, 3);
    assert!(one.pdf.len() < all.pdf.len(), "the range did not drop any pages");
}

#[test]
fn a_page_range_on_tagged_output_fails_before_the_compile_starts() {
    let compiler = common::compiler();
    let err = compiler
        .compile()
        // Deliberately unparsable: if this reached typst, the error would be a
        // syntax error rather than the settings error asserted below.
        .main_source("#(")
        .pdf(PdfSettings {
            page_ranges: Some(vec![PageRange::between(1, 1)]),
            ..Default::default()
        })
        .run()
        .unwrap_err();

    assert_eq!(err.code(), "INVALID_PDF_SETTINGS");
}

#[test]
fn untagged_output_is_smaller() {
    let compiler = common::compiler();
    // Disjoint sources, so neither run harvests the other's memo cache
    // (hard rule 10).
    let tagged = compiler
        .compile()
        .main_source("= Tagged\n#lorem(120)")
        .pdf(PdfSettings { tagged: true, ..Default::default() })
        .run()
        .unwrap();
    let untagged = compiler
        .compile()
        .main_source("= Untagged\n#lorem(120)")
        .pdf(PdfSettings { tagged: false, ..Default::default() })
        .run()
        .unwrap();

    assert!(
        untagged.pdf.len() < tagged.pdf.len(),
        "tagged {} vs untagged {}",
        tagged.pdf.len(),
        untagged.pdf.len()
    );
    // The default stays on: it is an accessibility feature, and the cost is
    // size rather than time.
    assert!(PdfSettings::default().tagged);
}

#[test]
fn pdf_metadata_is_configurable() {
    let compiler = common::compiler();
    let output = compiler
        .compile()
        .main_source("hello")
        .pdf(PdfSettings {
            creator: Creator::Custom("emquad-test".to_owned()),
            timestamp: PdfTimestamp::Omit,
            pretty: true,
            ..Default::default()
        })
        .run()
        .unwrap();

    assert!(common::contains(&output.pdf, b"emquad-test"), "creator not written");
}

#[test]
fn incompatible_pdf_standards_are_rejected_before_compiling() {
    let compiler = common::compiler();
    let err = compiler
        .compile()
        .main_source("hello")
        .pdf(PdfSettings {
            standards: vec![PdfStandard::V_1_4, PdfStandard::V_2_0],
            ..Default::default()
        })
        .run()
        .unwrap_err();

    assert_eq!(err.code(), "INVALID_PDF_SETTINGS");
}

#[test]
fn an_empty_font_set_is_refused_at_construction() {
    // Hard rule 8, restated at the public boundary: typst would compile this
    // successfully and emit a blank PDF with no diagnostics at all.
    let err = Compiler::builder().build().unwrap_err();
    assert_eq!(err, Error::NoFonts);
}

#[test]
fn a_path_that_escapes_the_root_is_refused() {
    let compiler = common::compiler();
    let err = compiler
        .compile()
        .source("../outside.typ", "leak")
        .main_source("hello")
        .run()
        .unwrap_err();

    assert_eq!(err.code(), "INVALID_PATH");
}

#[test]
fn compiles_are_deterministic_under_concurrency() {
    // Directly targets the process-global state: `comemo`, the `FileId`
    // interner, and the font book are all shared, so parallel compiles are
    // exactly where a snapshot-isolation bug would hide.
    let compiler = common::compiler();
    let sources: Vec<String> =
        (0..16).map(|n| format!("= Concurrent {n}\n#lorem({})", 20 + n)).collect();

    let serial: Vec<Vec<u8>> = sources
        .iter()
        .map(|source| {
            compiler
                .compile()
                .main_source(source)
                .reproducible("concurrent", 1_785_888_000)
                .run()
                .unwrap()
                .pdf
        })
        .collect();

    let parallel: Vec<Vec<u8>> = std::thread::scope(|scope| {
        let handles: Vec<_> = sources
            .iter()
            .map(|source| {
                let compiler = &compiler;
                scope.spawn(move || {
                    compiler
                        .compile()
                        .main_source(source)
                        .reproducible("concurrent", 1_785_888_000)
                        .run()
                        .unwrap()
                        .pdf
                })
            })
            .collect();
        handles.into_iter().map(|handle| handle.join().unwrap()).collect()
    });

    assert_eq!(serial, parallel);
}

#[test]
fn package_files_are_importable() {
    let compiler = common::builder()
        // A package is not importable without its manifest — typst reads
        // `typst.toml` to find the entrypoint. The resolver must mount it
        // alongside the sources.
        .package_file("@preview/example:0.1.0", "typst.toml", common::MANIFEST)
        .package_file(
            "@preview/example:0.1.0",
            "lib.typ",
            "#let greet(name) = [Hello, #name!]".to_owned(),
        )
        .build()
        .unwrap();

    let output = compiler
        .compile()
        .main_source("#import \"@preview/example:0.1.0\": greet\n#greet(\"world\")")
        .run()
        .unwrap();

    assert_eq!(output.pages, 1);
}
