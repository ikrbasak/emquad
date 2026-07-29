//! Node.js bindings for `emquad-engine`.
//!
//! **Thin, deliberately.** All compilation logic lives in `emquad-engine`; this
//! crate owns the JS boundary, the thread pool, and the cache lifecycle, and
//! nothing else. That split is what lets the core be tested with plain
//! `cargo test` and reused from a wasm or CLI target later.
//!
//! This is not the public API. `@emquad/core` wraps it in Phase 3 and is what
//! users import — in particular, a failed compile is *returned* here and turned
//! into a thrown `Error` subclass there. See `CompileResult` in `convert`.
//!
//! # What this layer must never do
//!
//! - **Let a panic reach Node.** It aborts the process. Every entry point is
//!   wrapped in `catch_unwind`.
//! - **Offer a `timeout` option.** Typst has no cancellation hook and a Rust
//!   thread cannot be forcibly killed, so a timeout would leak a wedged worker
//!   while looking like protection. Untrusted templates need process isolation.
//! - **Make per-request VFS paths convenient.** They are interned process-wide
//!   and never freed; the engine guards at 50,000 of them, but an API that
//!   invites the mistake is still a bad API.

// napi's JS-value types (`Uint8Array`, `Either`) are not `Debug`, so the option
// structs that carry them cannot derive it either. Printing a request would mean
// printing megabytes of font bytes, which nobody wants anyway.
#![allow(missing_debug_implementations)]

mod convert;
mod pool;

use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;

use napi::Env;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use convert::{
    ClockOptions, CompileResult, FileData, OwnedData, PackageFile, PdfOptions, own, own_all,
};
use pool::{Pool, SubmitError};

/// The default `comemo` eviction age.
///
/// Phase 0, over 100,000 compiles: no eviction grew RSS by **902 MB** and
/// oscillated between 0.68 and 1.14 GB. `evict(16)` bounded it to ~40 MB for
/// 5.9% throughput, against `evict(2)`'s 9.8%. Hence 16 rather than 2.
const DEFAULT_MAX_AGE: u32 = 16;

/// How many jobs may wait behind the workers before submission is refused.
const DEFAULT_QUEUE_CAPACITY: u32 = 1024;

#[napi(object)]
#[derive(Default)]
pub struct CompilerOptions {
    /// Font files. At least one face must parse, or construction fails with
    /// `NO_FONTS` — typst would otherwise compile happily and emit a valid PDF
    /// with every text run silently dropped and no diagnostics at all.
    pub fonts: Vec<Uint8Array>,

    /// The shared base VFS layer: templates, logos, data that does not change
    /// per request. Built once; rebuilding it per compile would invalidate the
    /// memo cache.
    pub files: Option<HashMap<String, FileData>>,

    /// `@preview` package files. Fetching them is the resolver's job, in
    /// TypeScript — this layer only stores what it is handed.
    pub packages: Option<Vec<PackageFile>>,

    /// Compile threads. Defaults to `availableParallelism()`.
    ///
    /// There is no single correct value: Phase 0 measured scaling to 3.71× at
    /// four threads on simple documents but a *collapse* to 0.46× on documents
    /// with many page runs. Scaling is document-shape dependent.
    pub pool_size: Option<u32>,

    /// Queue depth before `compile()` refuses new work. Default 1024.
    pub queue_capacity: Option<u32>,

    /// `comemo` eviction age, or `false` to disable eviction entirely.
    ///
    /// **The cache is process-global.** Two `Compiler` instances share it and
    /// are not isolated from each other; this setting belongs to whichever pool
    /// runs the compile.
    pub cache_max_age: Option<Either<u32, bool>>,

    /// Confine typst's internal rayon to one thread per compile.
    ///
    /// **Default `false`.** It buys nothing under this pool and costs ~15% at
    /// low concurrency; see `emquad_engine::rayon`. The knob remains because
    /// Phase 0's original measurement used a different mechanism that has not
    /// been reproduced.
    pub pin_rayon: Option<bool>,
}

#[napi(object)]
#[derive(Default)]
pub struct CompileRequest {
    /// The main document's source. Written to `/main.typ`.
    ///
    /// This is the normal entry point, and its shape is the point: **content
    /// varies per request, the path never does.** Naming a file per request
    /// leaks an interned path that is never freed.
    pub source: Option<String>,

    /// Use an existing file as the main document instead of `source`.
    pub main: Option<String>,

    /// Per-request files. Shadow the base layer for this compile only.
    pub files: Option<HashMap<String, FileData>>,

    pub clock: Option<ClockOptions>,
    pub pdf: Option<PdfOptions>,
}

/// Pool and interner counters, for metrics.
#[napi(object)]
#[derive(Debug)]
pub struct Stats {
    pub pool_size: u32,
    pub queue_capacity: u32,
    /// Jobs waiting, not counting those in flight.
    pub queued: u32,
    /// Distinct VFS paths interned process-wide, including any typst interned
    /// itself. **This is the number that predicts a crash** — export
    /// `interned / pathLimit`.
    pub interned_paths: u32,
    /// Paths interned through this library's wrapper. Never exceeds
    /// `internedPaths`.
    pub tracked_paths: u32,
    /// Where the guard trips.
    pub path_limit: u32,
    /// Typst's hard cap, past which it panics.
    pub path_cap: u32,
}

struct Inner {
    compiler: emquad_engine::Compiler,
    pool: Pool,
}

/// A long-lived compiler. Cheap to share, expensive to construct.
#[napi]
pub struct Compiler {
    inner: Arc<Inner>,
}

/// An owned, `Send`-able compile request. Built on the JS thread, run on a
/// worker.
struct Prepared {
    source: Option<String>,
    main: Option<String>,
    files: Vec<(String, OwnedData)>,
    clock: emquad_engine::Clock,
    pdf: emquad_engine::PdfSettings,
}

#[napi]
impl Compiler {
    #[napi(constructor)]
    pub fn new(options: CompilerOptions) -> Result<Self> {
        let mut builder = emquad_engine::Compiler::builder();

        for font in &options.fonts {
            builder = builder.font(font.to_vec());
        }
        for (path, data) in own_all(options.files) {
            builder = match data {
                OwnedData::Text(text) => builder.source(&path, &text),
                OwnedData::Bytes(bytes) => builder.file(&path, bytes),
            };
        }
        for package in options.packages.unwrap_or_default() {
            builder = match own(package.data) {
                OwnedData::Text(text) => {
                    builder.package_file(&package.spec, &package.path, text)
                }
                OwnedData::Bytes(bytes) => {
                    builder.package_file(&package.spec, &package.path, bytes)
                }
            };
        }
        if let Some(pin) = options.pin_rayon {
            builder = builder.pin_rayon(pin);
        }

        let compiler = builder.build().map_err(usage_error)?;

        let size = options.pool_size.map(|n| n as usize).unwrap_or_else(num_cpus::get);
        let capacity = options.queue_capacity.unwrap_or(DEFAULT_QUEUE_CAPACITY) as usize;
        let max_age = match options.cache_max_age {
            None | Some(Either::B(true)) => Some(DEFAULT_MAX_AGE as usize),
            Some(Either::B(false)) => None,
            Some(Either::A(age)) => Some(age as usize),
        };

        Ok(Self {
            inner: Arc::new(Inner { compiler, pool: Pool::new(size, capacity, max_age) }),
        })
    }

    /// Compile on a pool thread, resolving a Promise when it finishes.
    ///
    /// Rejects only for usage errors — a bad argument, or a full queue. A
    /// *failed compile* resolves with `{ ok: false, error }`, because a promise
    /// rejection cannot carry structured diagnostics.
    #[napi(ts_return_type = "Promise<CompileResult>")]
    pub fn compile<'env>(
        &self,
        env: &'env Env,
        request: CompileRequest,
    ) -> Result<Object<'env>> {
        // Prepared on this thread on purpose: `Uint8Array` borrows V8 memory
        // and is not `Send`, and doing it here surfaces argument errors
        // synchronously rather than inside a promise.
        let prepared = prepare(request)?;
        let inner = Arc::clone(&self.inner);

        // Refuse *before* creating the deferred. A `JsDeferred` that is never
        // settled leaks its threadsafe function, and that keeps Node's event
        // loop alive forever — a hung process rather than a rejected call.
        if !self.inner.pool.has_room() {
            return Err(submit_error(SubmitError::QueueFull {
                capacity: self.inner.pool.capacity(),
            }));
        }

        let (deferred, promise) = env.create_deferred::<CompileResult, Resolver>()?;

        let job = move || {
            let result = run(&inner, prepared);
            deferred.resolve(Box::new(move |_| Ok(result)) as Resolver);
        };

        submit(&self.inner.pool, Box::new(job))?;
        Ok(promise)
    }

    /// Compile on the calling thread.
    ///
    /// Not a hedge. For batch workloads — N processes each looping over
    /// documents — async scheduling is pure overhead and this is faster. It is
    /// also the right call inside an existing `worker_thread`, where the pool
    /// would just add a hop.
    #[napi]
    pub fn compile_sync(&self, request: CompileRequest) -> Result<CompileResult> {
        let prepared = prepare(request)?;
        Ok(run(&self.inner, prepared))
    }

    #[napi(getter)]
    pub fn stats(&self) -> Stats {
        let paths = emquad_engine::paths::stats();
        Stats {
            pool_size: self.inner.pool.size() as u32,
            queue_capacity: self.inner.pool.capacity() as u32,
            queued: self.inner.pool.queued() as u32,
            interned_paths: paths.interned,
            tracked_paths: paths.tracked,
            path_limit: paths.limit,
            path_cap: paths.cap,
        }
    }

    /// Registered font families, deduplicated and sorted. Useful for telling a
    /// user why `text(font: "…")` did not match.
    #[napi(getter)]
    pub fn font_families(&self) -> Vec<String> {
        self.inner.compiler.fonts().families()
    }
}

#[cfg(feature = "test-hooks")]
#[napi]
impl Compiler {
    /// Panic inside a pool job, on purpose.
    ///
    /// A Rust panic reaching Node aborts the whole process, so "we catch them"
    /// has to be demonstrated rather than claimed. Compiled only under the
    /// `test-hooks` feature; release builds do not contain it.
    #[napi(js_name = "__panicInPool", ts_return_type = "Promise<CompileResult>")]
    pub fn panic_in_pool<'env>(&self, env: &'env Env) -> Result<Object<'env>> {
        let (deferred, promise) = env.create_deferred::<CompileResult, Resolver>()?;
        let job = move || {
            let outcome = catch_unwind(AssertUnwindSafe(|| -> CompileResult {
                panic!("deliberate panic from __panicInPool");
            }));
            let result = match outcome {
                Ok(result) => result,
                Err(payload) => convert::panicked(panic_message(&*payload)),
            };
            deferred.resolve(Box::new(move |_| Ok(result)) as Resolver);
        };
        submit(&self.inner.pool, Box::new(job))?;
        Ok(promise)
    }
}

/// The exact Typst version this binary was built against.
///
/// Typst is pre-1.0 and rendering changes across minor releases, so a user
/// correlating output differences needs this at runtime, not just in a README.
#[napi]
pub fn typst_version() -> &'static str {
    emquad_engine::TYPST_VERSION
}

/// Evict the process-global `comemo` cache by hand.
///
/// The pool does this automatically. This exists for `compileSync()` callers,
/// who never touch the pool and would otherwise grow the cache without bound.
#[napi]
pub fn evict_cache(max_age: Option<u32>) {
    emquad_engine::cache::evict(max_age.unwrap_or(DEFAULT_MAX_AGE) as usize);
}

/// Lower the VFS path guard, for tests that need to reach it cheaply.
///
/// Returns the limit actually set — raising it past typst's 65,535 cap is
/// refused, since beyond that the guard could not fire before typst's own
/// panic.
#[napi]
pub fn set_path_limit(limit: u32) -> u32 {
    emquad_engine::paths::set_limit(limit)
}

type Resolver = Box<dyn FnOnce(Env) -> Result<CompileResult>>;

fn prepare(request: CompileRequest) -> Result<Prepared> {
    Ok(Prepared {
        source: request.source,
        main: request.main,
        files: own_all(request.files),
        clock: request.clock.unwrap_or_default().to_clock(),
        pdf: request.pdf.unwrap_or_default().to_settings()?,
    })
}

/// Run a prepared request. The only place a compile actually happens.
fn run(inner: &Inner, prepared: Prepared) -> CompileResult {
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        let mut compile = inner.compiler.compile();

        for (path, data) in prepared.files {
            compile = match data {
                OwnedData::Text(text) => compile.source(&path, &text),
                OwnedData::Bytes(bytes) => compile.file(&path, bytes),
            };
        }
        if let Some(source) = &prepared.source {
            compile = compile.main_source(source);
        }
        if let Some(main) = &prepared.main {
            compile = compile.main(main);
        }

        compile.clock(prepared.clock).pdf(prepared.pdf).run()
    }));

    match outcome {
        Ok(Ok(output)) => convert::success(output),
        Ok(Err(error)) => convert::failure(&error),
        // The engine already catches panics inside `run()`; this covers the
        // request assembly around it. Either way it must not reach Node.
        Err(payload) => convert::panicked(panic_message(&*payload)),
    }
}

/// Extract a panic's message.
///
/// Takes `&*payload`, never `&payload`: `Box<dyn Any + Send>` is itself `Any`,
/// so `&payload` coerces to a `&dyn Any` whose erased type is the *box*, and
/// every downcast silently fails. That produced "panic with a non-string
/// payload" for a plain `panic!("...")` before it was caught.
fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_owned()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "panic with a non-string payload".to_owned()
    }
}

/// Construction and argument problems throw, unlike compile outcomes: they are
/// programming mistakes rather than results.
fn usage_error(error: emquad_engine::Error) -> Error {
    Error::new(Status::InvalidArg, format!("[{}] {error}", error.code()))
}

/// Submit a job whose deferred already exists.
///
/// Only shutdown can fail here, `has_room` having already covered the queue.
/// Losing the job would strand its deferred, so this is the one place that must
/// not silently drop one.
fn submit(pool: &Pool, job: pool::Job) -> Result<()> {
    pool.submit(job).map_err(submit_error)
}

fn submit_error(error: SubmitError) -> Error {
    match error {
        SubmitError::QueueFull { capacity } => Error::new(
            Status::GenericFailure,
            format!(
                "[QUEUE_FULL] the compile queue is full ({capacity} waiting); \
                 shed load, retry later, or raise `queueCapacity`"
            ),
        ),
        SubmitError::ShuttingDown => {
            Error::new(Status::GenericFailure, "[SHUTTING_DOWN] the compile pool is closed")
        }
    }
}
