//! Q1 — runaway compiles: failure modes, blast radius, and whether a killable
//! child process is a viable mitigation.
//!
//! usage:
//!   runaway supervise <loop|membomb|deeprec>   parent: spawn, watch RSS, kill
//!   runaway child <loop|membomb|deeprec>       child: actually run the bomb
//!   runaway poolwedge                          does one wedged doc stall a pool?
//!   runaway oneshot                            compile one doc and exit
//!   runaway killcost <n>                       child-per-compile vs in-process

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use phase0::{compile_to_pdf, invoice, VfsWorld};

/// Tight loop: no recursion, no allocation — `MAX_DEPTH` cannot see this.
/// The condition must not be *statically* true: typst 0.15 lints `while true`
/// with "condition is always true" and rejects it before execution.
const TIGHT_LOOP: &str = r##"
#{
  let s = 0
  let n = 1
  while n > 0 { s = s + 1 }
}
= never reached
"##;

/// Unbounded allocation inside a loop. Same lint-avoidance as above.
const MEM_BOMB: &str = r##"
#{
  let a = ()
  let n = 1
  while n > 0 { a.push(range(10000)) }
}
= never reached
"##;

/// The realistic runaway: a *bounded* loop that is simply astronomically
/// large. No lint and no depth guard can reject this — it is a legal program.
const BIG_LOOP: &str = r##"
#{
  let s = 0
  for i in range(100000000) { s = s + i }
}
= never reached
"##;

/// The nastiest realistic case: nested `for` loops. 100M iterations, but every
/// `range()` array stays small, so memory stays flat — nothing detects it and
/// nothing bounds it. This is what an actual wedged worker looks like.
const SLOW_LOOP: &str = r##"
#{
  let s = 0
  for i in range(10000) { for j in range(10000) { s = s + 1 } }
}
= never reached
"##;

/// Deeply nested layout — grows the native stack via `stacker`.
const DEEP_NEST: &str = r##"
#let wrap(n, body) = if n == 0 { body } else { box(wrap(n - 1, body)) }
#wrap(100000, [x])
"##;

/// Infinite recursion — the one case `MAX_DEPTH` is supposed to catch.
const DEEP_RECURSION: &str = r##"
#let f(n) = f(n + 1)
#f(0)
"##;

fn bomb_src(kind: &str) -> &'static str {
    match kind {
        "loop" => TIGHT_LOOP,
        "membomb" => MEM_BOMB,
        "deeprec" => DEEP_RECURSION,
        "bigloop" => BIG_LOOP,
        "deepnest" => DEEP_NEST,
        "slowloop" => SLOW_LOOP,
        other => panic!("unknown bomb: {other}"),
    }
}

fn child_rss_kib(pid: u32) -> u64 {
    Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok())
        .unwrap_or(0)
}

const RSS_CAP_KIB: u64 = 2 * 1024 * 1024; // 2 GiB
const WALL_CAP: Duration = Duration::from_secs(20);

fn supervise(kind: &str) {
    let exe = std::env::current_exe().unwrap();
    let start = Instant::now();
    let mut child = Command::new(exe)
        .args(["child", kind])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn failed");
    let pid = child.id();

    let mut peak = 0u64;
    loop {
        match child.try_wait().expect("try_wait failed") {
            Some(status) => {
                println!(
                    "bomb={kind} outcome=EXITED_ON_ITS_OWN status={status:?} \
                     after={:?} peak_rss_kib={peak}",
                    start.elapsed()
                );
                let out = child.wait_with_output().unwrap();
                let all = format!(
                    "{}{}",
                    String::from_utf8_lossy(&out.stdout),
                    String::from_utf8_lossy(&out.stderr)
                );
                for line in all.lines().take(6) {
                    println!("  | {line}");
                }
                return;
            }
            None => {
                let rss = child_rss_kib(pid);
                peak = peak.max(rss);
                let over_mem = rss > RSS_CAP_KIB;
                let over_time = start.elapsed() > WALL_CAP;
                if over_mem || over_time {
                    let kill_start = Instant::now();
                    child.kill().expect("kill failed");
                    let status = child.wait().expect("wait failed");
                    println!(
                        "bomb={kind} outcome=KILLED_BY_SUPERVISOR \
                         reason={} after={:?} peak_rss_kib={peak} \
                         kill_latency={:?} status={status:?}",
                        if over_mem { "rss_cap" } else { "wall_clock" },
                        start.elapsed(),
                        kill_start.elapsed()
                    );
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

fn run_bomb(kind: &str) {
    let mut world = VfsWorld::new();
    world.set_main_source(bomb_src(kind));
    let opts = typst_pdf::PdfOptions::default();
    let warned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let result = typst::compile::<typst_layout::PagedDocument>(&world);
        match result.output {
            Ok(doc) => {
                let n = typst_pdf::pdf(&doc, &opts).map(|p| p.len()).unwrap_or(0);
                println!("compiled unexpectedly, pdf_bytes={n}");
            }
            Err(diags) => {
                println!("returned {} diagnostic(s) — a clean error, not a hang", diags.len());
                for d in diags.iter().take(3) {
                    println!("  {:?}: {}", d.severity, d.message);
                }
            }
        }
    }));
    if warned.is_err() {
        println!("PANICKED (caught) — would abort Node without catch_unwind");
    }
}

/// Does one wedged compile stall a whole pool, or only its own thread?
fn pool_wedge() {
    let done = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let start = Instant::now();

    std::thread::scope(|s| {
        // One poisoned worker.
        s.spawn(|| {
            let mut world = VfsWorld::new();
            world.set_main_source(SLOW_LOOP);
            let _ = typst::compile::<typst_layout::PagedDocument>(&world);
            println!("  poisoned worker returned — unexpected");
        });

        // Three healthy workers.
        for _ in 0..3 {
            let done = done.clone();
            s.spawn(move || {
                let mut world = VfsWorld::new();
                let opts = typst_pdf::PdfOptions::default();
                for i in 0..200 {
                    world.set_main_source(&invoice(i));
                    compile_to_pdf(&world, &opts);
                    done.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
            });
        }

        // Watch progress, then bail out — the poisoned thread never ends,
        // so the scope would otherwise block forever.
        let mut last = 0;
        for _ in 0..12 {
            std::thread::sleep(Duration::from_millis(500));
            let n = done.load(std::sync::atomic::Ordering::Relaxed);
            println!(
                "  t={:>5}ms healthy_docs_completed={n} (+{})",
                start.elapsed().as_millis(),
                n - last
            );
            last = n;
            if n >= 600 {
                println!("  all 600 healthy docs finished while one thread stayed wedged");
                break;
            }
        }
        println!("  exiting process (the wedged thread cannot be joined)");
        std::process::exit(0);
    });
}

fn kill_cost(n: usize) {
    // In-process baseline.
    let mut world = VfsWorld::new();
    let opts = typst_pdf::PdfOptions::default();
    world.set_main_source(&invoice(0));
    compile_to_pdf(&world, &opts);

    let start = Instant::now();
    for i in 1..=n {
        world.set_main_source(&invoice(i));
        compile_to_pdf(&world, &opts);
    }
    let in_proc = start.elapsed().as_secs_f64() * 1e6 / n as f64;

    // Child process per compile.
    let exe = std::env::current_exe().unwrap();
    let start = Instant::now();
    for _ in 0..n {
        let status = Command::new(&exe)
            .arg("oneshot")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("spawn failed");
        assert!(status.success());
    }
    let per_child = start.elapsed().as_secs_f64() * 1e6 / n as f64;

    println!("in_process       = {in_proc:.0} us/doc");
    println!("child_per_compile= {per_child:.0} us/doc");
    println!(
        "overhead         = {:.0} us/doc ({:.1}x slower)",
        per_child - in_proc,
        per_child / in_proc
    );
    println!("# note: each child pays the cold-start memo cost; a *reusable*");
    println!("# worker process amortizes that and only pays IPC per document.");
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(|s| s.as_str()) {
        Some("supervise") => supervise(args.get(2).map(|s| s.as_str()).unwrap_or("loop")),
        Some("child") => run_bomb(args.get(2).map(|s| s.as_str()).unwrap_or("loop")),
        Some("poolwedge") => pool_wedge(),
        Some("oneshot") => {
            let mut world = VfsWorld::new();
            world.set_main_source(&invoice(1));
            compile_to_pdf(&world, &typst_pdf::PdfOptions::default());
        }
        Some("killcost") => kill_cost(args.get(2).and_then(|s| s.parse().ok()).unwrap_or(50)),
        _ => eprintln!("see header for usage"),
    }
}
