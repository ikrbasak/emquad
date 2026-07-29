//! Confining typst's internal rayon usage.
//!
//! `typst-layout` parallelizes over *page runs* on the rayon pool that is
//! current for the calling thread. A page run is created by page
//! re-configuration, not by page count, so an ordinary document has exactly one
//! and rayon never engages. Documents that do create many runs behave very
//! differently, and Phase 0 measured it:
//!
//! | Shape | Threads, 16-way | Processes, 16-way |
//! |---|---|---|
//! | Simple invoice | 3.71× at 4, then flat | same plateau |
//! | 40 page runs | **0.46×** — worse than serial | 5.18× |
//!
//! Phase 0 concluded that restricting typst to one rayon thread was worth up
//! to **43%** on the multi-run shape. Phase 2 measured it under a real worker
//! pool and **could not reproduce any benefit at all**, so pinning is now
//! **off by default**.
//!
//! # What Phase 2 measured
//!
//! `packages/binding/bench/poolcmp.sh`, release build, one configuration per
//! process, order alternated across repetitions. Throughput in docs/s:
//!
//! | Threads | multirun, pinned | multirun, unpinned | invoice, pinned | invoice, unpinned |
//! |---|---|---|---|---|
//! | 1 | 252 | **296** | 1313 | 1370 |
//! | 2 | 216 | 230 | 2615 | 2632 |
//! | 4 | **218** | 203 | 4031 | 4561 |
//! | 8 | 113 | 114 | 4456 | 5310 |
//!
//! Two things follow, and the second matters more.
//!
//! 1. **Pinning has no consistent benefit.** It costs ~15% at one thread, wins
//!    ~5% at four, and is a tie at eight. On ordinary documents it does nothing.
//!    A knob with no reliable direction should not be on by default.
//!
//! 2. **Rayon is not what makes multi-run documents collapse.** With typst
//!    confined to a single rayon thread per worker — verified by the test below
//!    — throughput still falls to **0.45×** at eight threads. Whatever the
//!    contention is, it is not nested parallelism, and Phase 0 already pointed
//!    at the likeliest culprit: `comemo`'s process-global cache. Separate
//!    processes scaled to 5.18× on the same document.
//!
//! **So the fix for the collapse is process isolation, not rayon tuning.** That
//! is the worker-process pool, and this measurement is the strongest argument
//! for shipping it.
//!
//! # What is still unknown
//!
//! Phase 0's +43% was measured with `RAYON_NUM_THREADS=1`, which shrinks the
//! *global* pool that every worker injects into. This crate pins differently —
//! a private one-thread pool per worker, running inline. The two should be
//! close, and are not. That gap is unexplained, and it is the reason this knob
//! still exists rather than being deleted.
//!
//! # Why not `RAYON_NUM_THREADS`
//!
//! It is process-global and would silently shrink a host application's own
//! rayon pool. Instead, each thread that compiles gets a private one-thread
//! pool that includes *itself* (`use_current_thread`), so the work runs inline
//! with no hand-off and no extra threads.
//!
//! # The trade-off, stated plainly
//!
//! Registering the current thread makes it a member of that pool for the rest
//! of its life, and the registry is leaked — rayon documents both. On our own
//! worker threads that is exactly what we want. A Rust host that calls
//! `compile` from a thread it also uses for its own rayon work would see that
//! work confined too, so it can opt out with
//! [`CompilerBuilder::pin_rayon(false)`](crate::CompilerBuilder::pin_rayon).
//!
//! If the calling thread already belongs to someone else's rayon pool, rayon
//! refuses the registration. That is not an error: we run the closure directly
//! and typst uses the pool the caller already established.

use std::cell::OnceCell;

use rayon::ThreadPool;

thread_local! {
    /// `None` means registration was refused because this thread already
    /// belongs to another pool.
    static PINNED: OnceCell<Option<ThreadPool>> = const { OnceCell::new() };
}

/// Run `f` with typst's rayon parallelism confined to this thread.
pub(crate) fn pinned<T: Send>(f: impl FnOnce() -> T + Send) -> T {
    PINNED.with(|cell| {
        let pool = cell.get_or_init(|| {
            rayon::ThreadPoolBuilder::new().num_threads(1).use_current_thread().build().ok()
        });
        match pool {
            Some(pool) => pool.install(f),
            // Already inside someone else's pool. Honor it.
            None => f(),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typst_sees_a_single_rayon_thread() {
        let threads = pinned(rayon::current_num_threads);
        assert_eq!(threads, 1);
    }

    #[test]
    fn pinning_is_idempotent_on_a_thread() {
        assert_eq!(pinned(rayon::current_num_threads), 1);
        assert_eq!(pinned(rayon::current_num_threads), 1);
    }

    #[test]
    fn a_thread_inside_another_pool_is_left_alone() {
        let host = rayon::ThreadPoolBuilder::new().num_threads(2).build().unwrap();
        // Registration is refused, so the host's pool stays in charge rather
        // than the call failing.
        let threads = host.install(|| pinned(rayon::current_num_threads));
        assert_eq!(threads, 2);
    }
}
