//! Diagnostic fidelity.
//!
//! Positions are the whole point: a binding that reports "compilation failed"
//! and nothing else is what this crate exists to improve on. These tests are
//! table-driven against sources with a known-bad token at a known position.

mod common;

use emquad_engine::Severity;

/// Compile a source expected to fail, returning its diagnostics.
fn errors(source: &str) -> Vec<emquad_engine::Diagnostic> {
    let compiler = common::compiler();
    let err = compiler.compile().main_source(source).run().unwrap_err();
    let diagnostics = err.diagnostics().to_vec();
    assert!(!diagnostics.is_empty(), "expected diagnostics from:\n{source}");
    diagnostics
}

#[test]
fn line_and_column_are_exact_and_one_based() {
    // (source, expected line, expected column, fragment of the message)
    let cases: &[(&str, u32, u32, &str)] = &[
        ("#undefined_function()", 1, 2, "unknown variable"),
        ("ok\n#undefined_function()", 2, 2, "unknown variable"),
        ("ok\nok\n  #undefined_function()", 3, 4, "unknown variable"),
        ("#(1 + )", 1, 6, "expected expression"),
    ];

    for &(source, line, column, fragment) in cases {
        let diagnostic = &errors(source)[0];
        let position = diagnostic
            .position
            .as_ref()
            .unwrap_or_else(|| panic!("no position for:\n{source}"));

        assert_eq!(position.file, "/main.typ", "source:\n{source}");
        assert_eq!(position.line, line, "line, for source:\n{source}");
        assert_eq!(position.column, column, "column, for source:\n{source}");
        assert!(
            diagnostic.message.contains(fragment),
            "message {:?} does not contain {fragment:?}",
            diagnostic.message
        );
    }
}

#[test]
fn columns_count_characters_not_bytes() {
    // Four astral-plane characters, four bytes each, precede the error. `nope`
    // starts at byte 18 and character 6, so counting bytes would report column
    // 19 rather than 7.
    let diagnostic = &errors("𝄞𝄞𝄞𝄞 #nope()")[0];
    let position = diagnostic.position.as_ref().unwrap();
    assert_eq!((position.line, position.column), (1, 7));
}

#[test]
fn hints_on_errors_are_preserved() {
    // Typst's hints are usually the actionable half of the message, and the
    // existing binding discards them.
    let diagnostic = &errors("#let (a, b) = (1,)")[0];
    assert!(
        diagnostic.hints.iter().any(|hint| hint.message.contains("length of 1")),
        "hints were dropped: {diagnostic:#?}"
    );
}

#[test]
fn hints_on_warnings_survive_a_successful_compile() {
    let compiler = common::compiler();
    let output = compiler.compile().main_source("#show page: it => it\nhello").run().unwrap();

    let warning = output
        .warnings
        .iter()
        .find(|w| w.message.contains("`show page`"))
        .unwrap_or_else(|| panic!("warning lost on success: {:#?}", output.warnings));

    assert_eq!(warning.severity, Severity::Warning);
    assert_eq!(warning.file(), Some("/main.typ"));
    assert_eq!(warning.line(), Some(1));
    assert!(
        warning.hints.iter().any(|hint| hint.message.contains("set page(..)")),
        "hint lost: {warning:#?}"
    );
}

#[test]
fn errors_inside_an_import_report_the_imported_file_and_a_trace() {
    let compiler = common::builder()
        .source("/lib/broken.typ", "#let boom() = { undefined_thing }")
        .build()
        .unwrap();

    let err = compiler
        .compile()
        .main_source("#import \"/lib/broken.typ\": boom\n#boom()")
        .run()
        .unwrap_err();

    let diagnostics = err.diagnostics();
    let diagnostic = &diagnostics[0];

    assert_eq!(
        diagnostic.file(),
        Some("/lib/broken.typ"),
        "the error is in the imported file, not the caller"
    );
    // Without the trace there is no way to find the call site.
    assert!(!diagnostic.trace.is_empty(), "trace was dropped: {diagnostic:#?}");
    assert_eq!(
        diagnostic.trace[0].position.as_ref().map(|p| p.file.as_str()),
        Some("/main.typ")
    );
}

#[test]
fn errors_inside_a_package_report_the_package_path() {
    let compiler = common::builder()
        .package_file("@preview/example:0.1.0", "typst.toml", common::MANIFEST)
        .package_file(
            "@preview/example:0.1.0",
            "lib.typ",
            "#let boom() = { undefined_thing }".to_owned(),
        )
        .build()
        .unwrap();

    let err = compiler
        .compile()
        .main_source("#import \"@preview/example:0.1.0\": boom\n#boom()")
        .run()
        .unwrap_err();

    assert_eq!(err.diagnostics()[0].file(), Some("@preview/example:0.1.0/lib.typ"));
}

#[test]
fn errors_are_errors_and_warnings_are_warnings() {
    let diagnostics = errors("#undefined_function()");
    assert_eq!(diagnostics[0].severity, Severity::Error);
}

#[test]
fn diagnostics_render_readably() {
    let rendered = errors("ok\n#undefined_function()")[0].to_string();
    assert!(rendered.starts_with("error at /main.typ:2:2:"), "{rendered}");
}
