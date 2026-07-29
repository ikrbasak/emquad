//! Q4 — what `PdfOptions.tagged` (default `true`) actually costs.
//! Measures compile+export time and output size, tagged on vs off,
//! on both the single-page invoice and the multi-page report.

use phase0::{invoice, report, VfsWorld};
use typst_layout::PagedDocument;

/// `base` must differ per configuration. Both configurations compile the same
/// *kind* of document, so if they share indices the second one measured gets
/// free `comemo` hits from the first and looks ~2x faster than it is.
fn bench(
    name: &str,
    src_of: impl Fn(usize) -> String,
    n: usize,
    tagged: bool,
    base: usize,
) -> (f64, usize) {
    let mut world = VfsWorld::new();
    let opts = typst_pdf::PdfOptions { tagged, ..Default::default() };

    // Warm up.
    world.set_main_source(&src_of(base));
    let d = typst::compile::<PagedDocument>(&world).output.unwrap();
    let mut size = typst_pdf::pdf(&d, &opts).unwrap().len();

    let start = std::time::Instant::now();
    for i in 1..=n {
        world.set_main_source(&src_of(base + i));
        let d = typst::compile::<PagedDocument>(&world).output.unwrap();
        size = typst_pdf::pdf(&d, &opts).unwrap().len();
    }
    let per_us = start.elapsed().as_secs_f64() * 1e6 / n as f64;
    println!("{name}\ttagged={tagged}\t{per_us:.0} us/doc\t{size} bytes");
    (per_us, size)
}

/// Isolate the export half: layout once, then export repeatedly.
fn bench_export_only(name: &str, src: &str, n: usize, tagged: bool) -> (f64, usize) {
    let mut world = VfsWorld::new();
    world.set_main_source(src);
    let doc = typst::compile::<PagedDocument>(&world).output.unwrap();
    let opts = typst_pdf::PdfOptions { tagged, ..Default::default() };

    let mut size = typst_pdf::pdf(&doc, &opts).unwrap().len();
    let start = std::time::Instant::now();
    for _ in 0..n {
        size = typst_pdf::pdf(&doc, &opts).unwrap().len();
    }
    let per_us = start.elapsed().as_secs_f64() * 1e6 / n as f64;
    println!("{name}\ttagged={tagged}\t{per_us:.0} us/export\t{size} bytes");
    (per_us, size)
}

fn main() {
    println!("== full pipeline (compile + export), distinct documents ==");
    println!("   (disjoint index ranges per config, so neither reuses the other's memo entries)");
    let (t_on, s_on) = bench("invoice", invoice, 300, true, 10_000_000);
    let (t_off, s_off) = bench("invoice", invoice, 300, false, 20_000_000);
    println!(
        "-> invoice: time {:+.1}%  size {:+.1}%  (tagged on vs off)",
        (t_on / t_off - 1.0) * 100.0,
        (s_on as f64 / s_off as f64 - 1.0) * 100.0
    );

    let (t_on, s_on) = bench("report", report, 20, true, 30_000_000);
    let (t_off, s_off) = bench("report", report, 20, false, 40_000_000);
    println!(
        "-> report:  time {:+.1}%  size {:+.1}%  (tagged on vs off)",
        (t_on / t_off - 1.0) * 100.0,
        (s_on as f64 / s_off as f64 - 1.0) * 100.0
    );

    println!("\n== PDF export only (layout excluded) ==");
    let (e_on, _) = bench_export_only("invoice", &invoice(1), 500, true);
    let (e_off, _) = bench_export_only("invoice", &invoice(1), 500, false);
    println!("-> invoice export: {:+.1}%", (e_on / e_off - 1.0) * 100.0);

    let (e_on, _) = bench_export_only("report", &report(1), 30, true);
    let (e_off, _) = bench_export_only("report", &report(1), 30, false);
    println!("-> report export:  {:+.1}%", (e_on / e_off - 1.0) * 100.0);
}
