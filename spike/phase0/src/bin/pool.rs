//! Q3 — throughput vs. pool size.
//! Each worker owns its own `World`; the `comemo` cache is process-global and
//! shared, so this also measures cache lock contention.
//! usage: pool <docs_per_thread> [max_threads]

use phase0::{compile_to_pdf, doc_for, doc_name, invoice, VfsWorld};

fn main() {
    let per_thread: usize = std::env::args()
        .nth(1)
        .map(|s| s.parse().unwrap())
        .unwrap_or(400);
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(8);
    let max_threads: usize = std::env::args()
        .nth(2)
        .map(|s| s.parse().unwrap())
        .unwrap_or(cores * 2);

    println!("# cores={cores} docs_per_thread={per_thread} doc={} rayon_num_threads={}", doc_name(), std::env::var("RAYON_NUM_THREADS").unwrap_or_else(|_| "default".into()));
    println!("threads\ttotal_docs\twall_ms\tdocs_per_sec\tspeedup\tefficiency");

    let mut baseline = 0.0f64;

    for threads in 1..=max_threads {
        // Warm the cache identically before each measured run.
        {
            let mut w = VfsWorld::new();
            w.set_main_source(&invoice(0));
            compile_to_pdf(&w, &typst_pdf::PdfOptions::default());
        }

        let start = std::time::Instant::now();
        std::thread::scope(|s| {
            for t in 0..threads {
                s.spawn(move || {
                    let mut world = VfsWorld::new();
                    let opts = typst_pdf::PdfOptions::default();
                    // Disjoint document ranges: no accidental cross-thread memo hits.
                    let base = 1_000_000 * (t + 1);
                    for i in 0..per_thread {
                        world.set_main_source(&doc_for(base + i));
                        compile_to_pdf(&world, &opts);
                    }
                });
            }
        });
        let wall = start.elapsed();

        let total = threads * per_thread;
        let dps = total as f64 / wall.as_secs_f64();
        if threads == 1 {
            baseline = dps;
        }
        println!(
            "{threads}\t{total}\t{}\t{:.0}\t{:.2}x\t{:.0}%",
            wall.as_millis(),
            dps,
            dps / baseline,
            (dps / baseline / threads as f64) * 100.0
        );

        // Keep memory bounded across the sweep so later rows are not
        // penalized by earlier ones.
        comemo::evict(0);
    }
}
