//! Throughput benchmark, promoted from the Phase 0 spike.
//!
//! ```text
//! cargo bench --bench compile                 # invoice, 2000 documents
//! EMQUAD_DOC=multirun cargo bench --bench compile
//! EMQUAD_DOCS=10000 cargo bench --bench compile
//! EMQUAD_PIN=1 cargo bench --bench compile    # pin typst's rayon to 1 thread
//! ```
//!
//! No criterion: the interesting quantity here is steady-state throughput over
//! *distinct* documents, which criterion's repeat-until-stable sampling
//! actively works against — repeating one document measures the memo cache
//! instead of the compiler.
//!
//! Three rows are reported and only one of them is honest:
//!
//! - **Cold** — the first compile in a process. A one-time cost, worth knowing
//!   for short-lived Lambda-style invocations and a good argument for a warm-up
//!   compile at startup.
//! - **Distinct** — the number to quote.
//! - **Memoized** — a byte-identical document recompiled. Included only to show
//!   how misleading it is; no real server does this, and quoting it would be
//!   dishonest.
//!
//! # One configuration per process
//!
//! Hard rule 10 says configurations must not share document ranges, because the
//! second one measured would harvest `comemo` hits from the first. Disjoint
//! ranges are **not enough**, and this benchmark is where that was learned:
//! comparing pinned against unpinned rayon in a single process made the
//! second-measured configuration look 20% faster, purely because the two
//! documents differ only in a substituted number and share almost all of their
//! layout work.
//!
//! So each configuration gets its own process. `scripts/benchcmp.sh` runs the pair,
//! repeated and with alternating order so machine noise cannot masquerade as a
//! result.

#[path = "fixtures.rs"]
mod fixtures;

use std::time::Instant;

use emquad_engine::{Compiler, PdfSettings};

fn main() {
    let docs: usize = env("EMQUAD_DOCS", 2000);
    // Defaults to *unpinned*, because that is what `Compiler::builder()`
    // defaults to. It used to default the other way, which meant the headline
    // throughput number was measured in a configuration no user gets — worth
    // ~7% here, and it was a good part of the "unexplained" gap against the
    // Phase 0 probe, which never pinned. Opt in with `EMQUAD_PIN=1`.
    let pinned = std::env::var("EMQUAD_PIN").as_deref() == Ok("1");
    let name = fixtures::doc_name();
    let compiler = if pinned { fixtures::compiler() } else { fixtures::compiler_unpinned() };

    println!(
        "document: {name}, {docs} compiles, typst rayon: {}, typst {}",
        if pinned { "pinned to 1 thread" } else { "unpinned" },
        emquad_engine::TYPST_VERSION
    );

    let cold = time_one(&compiler, &fixtures::document(&name, 0));
    println!("  cold first compile   {:>10.2} ms", cold * 1e3);

    let distinct = bench(&compiler, &name, 1..=docs);
    report("distinct documents", distinct, docs);

    // Disjoint range from `distinct` — though for this row the point is
    // precisely that it re-reads the cache.
    let memoized = bench_same(&compiler, &fixtures::document(&name, 10_000_000), docs);
    report("same document (memoized, do not quote)", memoized, docs);
}

fn report(label: &str, seconds: f64, docs: usize) {
    let per = seconds / docs as f64;
    println!("  {label:<38} {:>8.1} µs  {:>8.0} docs/s", per * 1e6, 1.0 / per);
}

fn time_one(compiler: &Compiler, source: &str) -> f64 {
    let start = Instant::now();
    compile(compiler, source);
    start.elapsed().as_secs_f64()
}

fn bench(compiler: &Compiler, name: &str, range: std::ops::RangeInclusive<usize>) -> f64 {
    let sources: Vec<String> = range.map(|n| fixtures::document(name, n)).collect();
    let start = Instant::now();
    for source in &sources {
        compile(compiler, source);
    }
    start.elapsed().as_secs_f64()
}

fn bench_same(compiler: &Compiler, source: &str, docs: usize) -> f64 {
    let start = Instant::now();
    for _ in 0..docs {
        compile(compiler, source);
    }
    start.elapsed().as_secs_f64()
}

fn compile(compiler: &Compiler, source: &str) {
    let output = compiler
        .compile()
        .main_source(source)
        .pdf(PdfSettings::default())
        .run()
        .expect("benchmark document must compile");
    // Consume the output so LTO cannot dead-strip the pipeline. A Phase 0 probe
    // that skipped this reported a 376 KB binary for a full typesetting engine.
    std::hint::black_box(output.pdf.len());
}

fn env(key: &str, default: usize) -> usize {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}
