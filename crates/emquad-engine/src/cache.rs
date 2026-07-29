//! The `comemo` memoization cache.
//!
//! `comemo` is what makes typst fast, and it is process-global and unbounded.
//! Nothing evicts it unless someone calls [`evict`]. Phase 0 ran 100,000
//! distinct compiles to measure the shape of that:
//!
//! | Policy | µs/doc | Throughput | RSS growth |
//! |---|---|---|---|
//! | No eviction | 636.9 | 1,570/s | **+902 MB**, oscillating 0.68–1.14 GB |
//! | `evict(2)` | 706.4 | 1,416/s (−9.8%) | +8.5 MB |
//! | `evict(16)` | 676.7 | 1,478/s (−5.9%) | +13.9 MB |
//!
//! Both policies bound resident memory to roughly 40 MB against ~1 GB
//! unbounded. [`RECOMMENDED_MAX_AGE`] is 16 rather than 2 because it keeps
//! nearly all of the memory benefit for a little over half the throughput cost.
//!
//! Eviction is deliberately *not* automatic here. The engine does not know how
//! many compiles are in flight, and calling it mid-flight on one thread throws
//! away work another thread is about to reuse. The pool owns the policy.

/// The recommended `max_age`, from Phase 0.
pub const RECOMMENDED_MAX_AGE: usize = 16;

/// Evict cache entries untouched for `max_age` rounds.
///
/// Call this from the pool, between compiles — not from inside one.
pub fn evict(max_age: usize) {
    comemo::evict(max_age);
}
