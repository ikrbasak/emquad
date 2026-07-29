//! Q2b — exhaust the process-global `FileId` interner.
//! Confirms the cap, the panic behavior, and the memory cost per interned path.
//! usage: interner [target_count]

use phase0::{rss_kib, vfs_id};

fn main() {
    let target: usize = std::env::args()
        .nth(1)
        .map(|s| s.parse().unwrap())
        .unwrap_or(70_000);

    let baseline = rss_kib();
    println!("# baseline_rss_kib={baseline} target={target}");
    println!("count\trss_kib\tdelta_kib");

    // Interning happens purely through `FileId::new` — no compile needed.
    let result = std::panic::catch_unwind(|| {
        for i in 1..=target {
            let _ = vfs_id(&format!("invoice-{i}.typ"));
            if i % 5_000 == 0 {
                let rss = rss_kib();
                println!("{i}\t{rss}\t{}", rss as i64 - baseline as i64);
            }
        }
    });

    match result {
        Ok(()) => println!("# reached {target} paths WITHOUT panicking"),
        Err(e) => {
            let msg = e
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_else(|| "<non-string panic payload>".into());
            println!("# PANICKED: {msg:?}");
            println!("# catch_unwind DID contain it (process still alive)");
        }
    }
    println!("# final_rss_kib={}", rss_kib());
}
