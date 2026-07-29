//! The dedicated compile thread pool.
//!
//! # Why not the libuv threadpool
//!
//! napi's `AsyncTask` would be far less code, and it is the wrong tool.
//! `UV_THREADPOOL_SIZE` defaults to **4** and is shared with `fs`, DNS,
//! `crypto`, and zlib. A server under PDF load would silently cap at four
//! concurrent renders *and* stall unrelated file reads, with no symptom
//! pointing at this library. It is also tunable only by an environment
//! variable that must be set before any I/O happens.
//!
//! So: our own threads, our own bounded queue, our own backpressure.
//!
//! # Why the queue is bounded and rejects rather than blocks
//!
//! An unbounded queue under sustained overload converts a throughput problem
//! into an out-of-memory crash, and blocking the submitting thread would block
//! Node's event loop — the one thing an async API exists to avoid. So a full
//! queue is refused immediately and the caller decides what to do. That is the
//! only honest option at this boundary.
//!
//! # Why the pool owns eviction
//!
//! `comemo`'s cache is process-global, so no individual `Compiler` can evict
//! correctly — two compilers share one cache. The worker evicts after each
//! job, which is exactly the configuration Phase 0 measured.

use std::collections::VecDeque;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;

use emquad_engine::cache;

pub type Job = Box<dyn FnOnce() + Send + 'static>;

/// Submission was refused. The only failure a caller can act on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubmitError {
    /// The bounded queue is full. Retry, shed load, or raise `queueCapacity`.
    QueueFull { capacity: usize },
    /// The pool has been shut down.
    ShuttingDown,
}

pub struct Pool {
    shared: Arc<Shared>,
    workers: Vec<JoinHandle<()>>,
    size: usize,
    capacity: usize,
}

struct Shared {
    state: Mutex<State>,
    ready: Condvar,
    capacity: usize,
    /// `None` disables eviction, which trades bounded memory for ~6–10%
    /// throughput. Phase 0 measured ~40 MB against ~1 GB over 100k compiles.
    evict_max_age: Option<usize>,
}

struct State {
    jobs: VecDeque<Job>,
    shutdown: bool,
}

impl Pool {
    pub fn new(size: usize, capacity: usize, evict_max_age: Option<usize>) -> Self {
        let size = size.max(1);
        let capacity = capacity.max(1);
        let shared = Arc::new(Shared {
            state: Mutex::new(State { jobs: VecDeque::new(), shutdown: false }),
            ready: Condvar::new(),
            capacity,
            evict_max_age,
        });

        let workers = (0..size)
            .map(|index| {
                let shared = Arc::clone(&shared);
                std::thread::Builder::new()
                    .name(format!("emquad-compile-{index}"))
                    .spawn(move || worker(&shared))
                    .expect("spawning a compile worker")
            })
            .collect();

        Self { shared, workers, size, capacity }
    }

    pub fn size(&self) -> usize {
        self.size
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// Jobs waiting, not counting those in flight. Exposed for metrics and for
    /// the backpressure test.
    pub fn queued(&self) -> usize {
        self.shared.state.lock().expect("pool mutex").jobs.len()
    }

    /// Is there room for one more job?
    ///
    /// Callers must check this *before* creating a `JsDeferred`: a deferred
    /// that is never settled leaks its threadsafe function, which keeps Node's
    /// event loop alive forever. There is no race to worry about — `compile()`
    /// only ever runs on the JS thread, and workers only ever remove jobs.
    pub fn has_room(&self) -> bool {
        let state = self.shared.state.lock().expect("pool mutex");
        !state.shutdown && state.jobs.len() < self.shared.capacity
    }

    pub fn submit(&self, job: Job) -> Result<(), SubmitError> {
        let mut state = self.shared.state.lock().expect("pool mutex");
        if state.shutdown {
            return Err(SubmitError::ShuttingDown);
        }
        if state.jobs.len() >= self.shared.capacity {
            return Err(SubmitError::QueueFull { capacity: self.shared.capacity });
        }
        state.jobs.push_back(job);
        drop(state);
        self.shared.ready.notify_one();
        Ok(())
    }
}

impl Drop for Pool {
    fn drop(&mut self) {
        {
            let mut state = self.shared.state.lock().expect("pool mutex");
            state.shutdown = true;
        }
        self.shared.ready.notify_all();
        for worker in self.workers.drain(..) {
            // A worker that panicked is already gone; joining it still reaps it.
            let _ = worker.join();
        }
    }
}

impl std::fmt::Debug for Pool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Pool")
            .field("size", &self.size)
            .field("capacity", &self.capacity)
            .field("queued", &self.queued())
            .finish()
    }
}

fn worker(shared: &Arc<Shared>) {
    loop {
        let job = {
            let mut state = shared.state.lock().expect("pool mutex");
            loop {
                if let Some(job) = state.jobs.pop_front() {
                    break job;
                }
                if state.shutdown {
                    return;
                }
                state = shared.ready.wait(state).expect("pool condvar");
            }
        };

        // A panicking job must cost one compile, not the worker and not the
        // process. The job itself is responsible for settling its promise; this
        // is the backstop for a panic in that settling code.
        let _ = catch_unwind(AssertUnwindSafe(job));

        if let Some(max_age) = shared.evict_max_age {
            cache::evict(max_age);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn jobs_run_and_the_pool_drains_on_drop() {
        let done = Arc::new(AtomicUsize::new(0));
        let pool = Pool::new(2, 64, None);
        for _ in 0..32 {
            let done = Arc::clone(&done);
            pool.submit(Box::new(move || {
                done.fetch_add(1, Ordering::SeqCst);
            }))
            .unwrap();
        }
        drop(pool); // joins every worker, so all 32 must have run
        assert_eq!(done.load(Ordering::SeqCst), 32);
    }

    #[test]
    fn a_full_queue_is_refused_rather_than_growing() {
        // One worker, held busy, so the queue is the only place jobs can go.
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let pool = Pool::new(1, 2, None);

        let held = Arc::clone(&gate);
        pool.submit(Box::new(move || {
            let (lock, cvar) = &*held;
            let mut open = lock.lock().unwrap();
            while !*open {
                open = cvar.wait(open).unwrap();
            }
        }))
        .unwrap();

        // Fill the queue behind the occupied worker.
        while pool.queued() < 2 {
            pool.submit(Box::new(|| {})).unwrap();
        }

        match pool.submit(Box::new(|| {})) {
            Err(SubmitError::QueueFull { capacity }) => assert_eq!(capacity, 2),
            other => panic!("expected QueueFull, got {other:?}"),
        }

        let (lock, cvar) = &*gate;
        *lock.lock().unwrap() = true;
        cvar.notify_all();
    }

    #[test]
    fn a_panicking_job_does_not_take_down_its_worker() {
        let done = Arc::new(AtomicUsize::new(0));
        let pool = Pool::new(1, 8, None);

        pool.submit(Box::new(|| panic!("deliberate"))).unwrap();

        let done_after = Arc::clone(&done);
        pool.submit(Box::new(move || {
            done_after.fetch_add(1, Ordering::SeqCst);
        }))
        .unwrap();

        drop(pool);
        assert_eq!(done.load(Ordering::SeqCst), 1, "the worker died with the job");
    }
}
