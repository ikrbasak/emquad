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
//! Under a saturated pool, restricting typst to one rayon thread was worth up
//! to **43%** on the multi-run shape. Our own pool supplies the parallelism
//! (hard rule 9).
//!
//! # It is not free, and hard rule 9 overstates this
//!
//! That rule also says pinning is "never worse". Phase 1 measured otherwise.
//! Single-threaded, one compile at a time, `scripts/benchcmp.sh` reports:
//!
//! | Document | Pinned | Unpinned |
//! |---|---|---|
//! | Invoice (1 page run) | 652 µs | 652 µs — no difference |
//! | Multi-run (40 page runs) | 3,738 µs | **3,327 µs — 12% faster** |
//!
//! Three repetitions, alternating order, one configuration per process. The
//! result is not an artifact: with a single compile in flight there is nothing
//! to contend with, so letting rayon spread 40 page runs across idle cores is
//! straightforwardly faster than forcing them onto one.
//!
//! Phase 0's +43% was measured with *many* worker threads compiling at once,
//! where typst's rayon oversubscribes on top of our pool. Both numbers are
//! right; the rule needs the qualifier.
//!
//! The default stays on because the failure modes are asymmetric: unpinned
//! under a saturated pool collapsed to **0.46×**, and 12% on an unusual
//! document shape is much the smaller loss. **Phase 2 owns the final call** —
//! it should re-measure pinned against unpinned under its own worker pool and
//! set [`CompilerBuilder::pin_rayon`](crate::CompilerBuilder::pin_rayon)
//! deliberately rather than inheriting this default.
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
