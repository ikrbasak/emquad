//! Q2 — memory over a long run.
//! usage: soak <iterations> <none|evict:N>

use phase0::{compile_to_pdf, invoice, rss_kib, VfsWorld};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let iters: usize = args.get(1).map(|s| s.parse().unwrap()).unwrap_or(100_000);
    let policy = args.get(2).cloned().unwrap_or_else(|| "none".into());
    let max_age: Option<usize> = policy
        .strip_prefix("evict:")
        .map(|n| n.parse().expect("bad max_age"));

    let mut world = VfsWorld::new();
    let opts = typst_pdf::PdfOptions::default();

    // Warm up so the cold-compile cost is not attributed to the curve.
    world.set_main_source(&invoice(0));
    compile_to_pdf(&world, &opts);

    let baseline = rss_kib();
    println!("# policy={policy} iterations={iters} baseline_rss_kib={baseline}");
    println!("iter\trss_kib\tdelta_kib\telapsed_ms");

    let start = std::time::Instant::now();
    let sample_every = (iters / 50).max(1);

    for i in 1..=iters {
        world.set_main_source(&invoice(i));
        compile_to_pdf(&world, &opts);
        if let Some(age) = max_age {
            comemo::evict(age);
        }
        if i % sample_every == 0 || i == iters {
            let rss = rss_kib();
            println!(
                "{i}\t{rss}\t{}\t{}",
                rss as i64 - baseline as i64,
                start.elapsed().as_millis()
            );
        }
    }

    let per = start.elapsed() / iters as u32;
    println!(
        "# done per_doc={:?} docs_per_sec={:.0} final_rss_kib={} growth_kib={}",
        per,
        1.0 / per.as_secs_f64(),
        rss_kib(),
        rss_kib() as i64 - baseline as i64
    );
}
