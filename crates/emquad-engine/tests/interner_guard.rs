//! The path-interning guard.
//!
//! Its own test binary on purpose: the limit, the interner, and its high-water
//! mark are all process-global. For the same reason this is a single test with
//! ordered phases rather than several — cargo runs tests in one binary
//! concurrently, and they would fight over the limit.

use emquad_engine::paths::{self, VfsPath};
use emquad_engine::{Compiler, Error};

const LIMIT: u32 = 512;

#[test]
fn the_guard_fires_before_typst_panics_and_says_what_to_fix() {
    // --- The limit is clamped to typst's cap ---------------------------------
    //
    // Past the cap the guard could not fire before `expect("out of file ids")`
    // aborts the process, which is the entire reason it exists.
    assert_eq!(paths::set_limit(u32::MAX), paths::stats().cap);
    assert_eq!(paths::stats().cap, 65_535);

    // --- Pressure is observable ---------------------------------------------
    assert_eq!(paths::set_limit(LIMIT), LIMIT);
    let before = paths::stats();
    let _ = VfsPath::project("/stats-probe.typ").unwrap().intern();
    let after = paths::stats();
    assert_eq!(after.limit, LIMIT);
    assert!(after.interned > before.interned);
    // `interned` tracks typst's whole interner and `tracked` only what we asked
    // for, so the first can outrun the second but never the other way around.
    assert!(after.interned >= after.tracked);

    // --- The guard errors rather than letting typst panic --------------------
    //
    // 512 is far below typst's 65,535, so the failure asserted here is ours.
    let mut interned = 0u32;
    let error = loop {
        assert!(interned < LIMIT * 2, "guard never fired after {interned} paths");
        let path = VfsPath::project(&format!("/invoice-{interned:08x}-4a19.typ")).unwrap();
        match path.intern() {
            Ok(_) => interned += 1,
            Err(error) => break error,
        }
    };

    match error {
        Error::PathVocabularyExhausted { path, pattern, matching, interned: total, limit } => {
            assert_eq!(limit, LIMIT);
            assert!(total >= LIMIT, "high-water mark {total} below the limit");
            assert!(path.starts_with("/invoice-"), "offending path: {path}");
            // Naming the *pattern* is the actionable part. "You are out of file
            // ids" is useless without knowing which template generated them.
            assert_eq!(pattern, "/invoice-*-*.typ");
            assert!(matching > 1, "only {matching} paths matched the pattern");
        }
        other => panic!("expected PathVocabularyExhausted, got {other}"),
    }

    // Already-interned paths keep working: the guard refuses growth, not use.
    assert!(VfsPath::project("/invoice-00000000-4a19.typ").unwrap().intern().is_ok());

    // --- And it surfaces through the compile API -----------------------------
    let compiler = {
        let mut builder = Compiler::builder();
        for data in typst_assets::fonts() {
            builder = builder.font(data);
        }
        builder.build().unwrap()
    };

    let err = compiler
        .compile()
        .source("/never-seen-before.typ", "x")
        .main_source("hello")
        .run()
        .unwrap_err();

    assert_eq!(err.code(), "PATH_VOCABULARY_EXHAUSTED");
    assert!(
        err.to_string().contains("stable path"),
        "the message must say what to do instead: {err}"
    );
}
