//! Memory soak, promoted from the Phase 0 spike.
//!
//! ```text
//! cargo bench --bench soak                          # 20k compiles, evict(16)
//! EMQUAD_SOAK=100000 EMQUAD_EVICT=none cargo bench --bench soak
//! ```
//!
//! Answers one question: does resident memory plateau? Phase 0's 100,000-compile
//! run said yes with eviction (~40 MB) and emphatically no without
//! (+902 MB, oscillating between 0.68 and 1.14 GB).
//!
//! `EMQUAD_EVICT` takes `none` or a `max_age`.

#[path = "fixtures.rs"]
mod fixtures;

use std::time::Instant;

use emquad_engine::cache;

fn main() {
    let docs: usize = env("EMQUAD_SOAK", 20_000);
    let policy = std::env::var("EMQUAD_EVICT")
        .unwrap_or_else(|_| cache::RECOMMENDED_MAX_AGE.to_string());
    let max_age: Option<usize> = policy.parse().ok();
    let name = fixtures::doc_name();
    let compiler = fixtures::compiler();

    println!("document: {name}, {docs} compiles, evict: {policy}");
    println!("{:>10}  {:>12}  {:>10}", "compiles", "RSS (MiB)", "µs/doc");

    let baseline = fixtures::rss_kib();
    let start = Instant::now();
    let mut mark = start;

    for n in 1..=docs {
        let output = compiler
            .compile()
            .main_source(&fixtures::document(&name, n))
            .run()
            .expect("soak document must compile");
        std::hint::black_box(output.pdf.len());

        if let Some(max_age) = max_age {
            cache::evict(max_age);
        }

        let step = docs / 20;
        if step > 0 && n % step == 0 {
            let per = mark.elapsed().as_secs_f64() / step as f64;
            println!(
                "{n:>10}  {:>12.1}  {:>10.1}",
                fixtures::rss_kib() as f64 / 1024.0,
                per * 1e6
            );
            mark = Instant::now();
        }
    }

    let growth = fixtures::rss_kib() as i64 - baseline as i64;
    let per = start.elapsed().as_secs_f64() / docs as f64;
    println!(
        "\nRSS growth {:+.1} MiB over {docs} compiles, {:.1} µs/doc, {:.0} docs/s",
        growth as f64 / 1024.0,
        per * 1e6,
        1.0 / per
    );
    println!("paths interned: {:?}", emquad_engine::paths::stats());
}

fn env(key: &str, default: usize) -> usize {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}
