import { type ChildProcess, fork } from "node:child_process";
import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

import type { CompileBackend } from "#/backend.ts";
import type { NativeCompileRequest, NativeCompileResult } from "#/binding.ts";
import { EmquadError, localError } from "#/errors.ts";
import type { PoolOptions, Stats } from "#/types.ts";
import type { ParentMessage, WorkerInit, WorkerMessage } from "#/pool/protocol.ts";

const DEFAULT_QUEUE_CAPACITY = 1024;
const DEFAULT_MAX_RESTARTS = 10;

/**
 * Where the worker entry lands after bundling.
 *
 * `process-pool.ts` is folded into `dist/index.js`, and `worker.ts` is a
 * second entry emitted beside it as `dist/worker.js`, so this resolves
 * correctly at runtime even though the source tree nests them differently.
 */
const WORKER_URL = new URL("./worker.js", import.meta.url);

interface PendingJob {
  id: number;
  request: NativeCompileRequest;
  settle: (result: NativeCompileResult) => void;
  fail: (error: EmquadError) => void;
}

interface Worker {
  child: ChildProcess;
  ready: boolean;
  job: PendingJob | undefined;
  timer: NodeJS.Timeout | undefined;
}

/**
 * A pool of Node processes, each holding its own compiler.
 *
 * ## Why this exists
 *
 * Two independent problems, one mechanism.
 *
 * **Throughput.** Documents with many page runs get *slower* as threads are
 * added — Phase 0 measured 0.46× at eight threads, against 5.18× for the same
 * work split across processes. Phase 2 eliminated the obvious explanation by
 * confining typst's internal rayon to one thread per worker and measuring the
 * collapse unchanged, which places the contention in process-global state,
 * most plausibly `comemo`'s cache. No amount of thread tuning reaches it.
 *
 * **Runaway templates.** Typst exposes no cancellation hook and a Rust thread
 * cannot be killed, so a pathological document wedges a thread for the life of
 * the process. A process can be killed, in 22–35 ms. This is the only real
 * mitigation for untrusted input, and it is why `timeoutMs` is a property of
 * this pool rather than of the compile API.
 *
 * ## What it costs
 *
 * Every worker parses its own fonts and keeps its own memo cache, and every
 * request and every PDF is copied across a process boundary. Workers are
 * therefore *reused*, never spawned per compile: Phase 0 measured
 * process-per-compile at 11.2× slower (877 µs → 9,819 µs).
 */
export class ProcessPool implements CompileBackend {
  readonly #init: WorkerInit;
  readonly #size: number;
  readonly #queueCapacity: number;
  readonly #timeoutMs: number | undefined;
  readonly #maxRestarts: number;

  readonly #workers: Worker[] = [];
  readonly #queue: PendingJob[] = [];
  readonly #statsWaiters = new Map<number, (stats: Stats) => void>();
  #readyWaiters: Array<{ ok: () => void; no: (error: EmquadError) => void }> = [];

  #nextId = 0;
  #restarts = 0;
  #closed = false;
  #fontFamilies: string[] = [];

  /**
   * Set when the pool can never work again — a font that will not parse, or a
   * worker that died more times than `maxRestarts` allows. Sticky on purpose:
   * these failures are deterministic, and retrying them forever would turn a
   * configuration mistake into a silent busy loop.
   */
  #fatal: EmquadError | undefined;

  constructor(init: WorkerInit, options: PoolOptions) {
    this.#init = init;
    this.#size = options.size ?? availableParallelism();
    this.#queueCapacity = options.queueCapacity ?? DEFAULT_QUEUE_CAPACITY;
    this.#timeoutMs = options.timeoutMs;
    this.#maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS;

    if (!existsSync(fileURLToPath(WORKER_URL))) {
      throw localError(
        "WORKER_START_FAILED",
        `worker entry not found at ${WORKER_URL.href}; @emquad/core was built incorrectly`,
      );
    }

    for (let i = 0; i < this.#size; i += 1) this.#spawn();
  }

  async compile(request: NativeCompileRequest): Promise<NativeCompileResult> {
    if (this.#fatal) throw this.#fatal;
    if (this.#closed) {
      throw localError("SHUTTING_DOWN", "the compile pool is closed");
    }

    return await new Promise<NativeCompileResult>((resolve, reject) => {
      const job: PendingJob = { id: (this.#nextId += 1), request, settle: resolve, fail: reject };
      const idle = this.#workers.find((worker) => worker.ready && !worker.job);

      if (idle) {
        this.#dispatch(idle, job);
      } else if (this.#queue.length < this.#queueCapacity) {
        this.#queue.push(job);
      } else {
        // Refuse rather than block. Blocking would convert an overload into
        // unbounded latency and hide it; refusing lets the caller shed load.
        reject(
          localError(
            "QUEUE_FULL",
            `the compile queue is full (${this.#queueCapacity} waiting); ` +
              "shed load, retry later, or raise `pool.queueCapacity`",
          ),
        );
      }
    });
  }

  compileSync(): never {
    throw localError(
      "INVALID_ARGUMENT",
      'compileSync() is unavailable under pool.mode "process": there is no synchronous ' +
        "path across a process boundary. Use compile(), or switch to the thread pool.",
    );
  }

  async stats(): Promise<Stats> {
    const ready = this.#workers.filter((worker) => worker.ready);
    const collected = await Promise.all(ready.map((worker) => this.#askStats(worker)));

    return {
      poolSize: this.#size,
      queueCapacity: this.#queueCapacity,
      queued: this.#queue.length,
      // The *maximum* across workers, not the sum. These counters predict a
      // hard process abort at typst's 65,535-path cap, and that cap is
      // per-process — so the worker closest to it is the one that matters. A
      // sum would read as alarming long before any single process was at risk.
      internedPaths: Math.max(0, ...collected.map((s) => s.internedPaths)),
      trackedPaths: Math.max(0, ...collected.map((s) => s.trackedPaths)),
      pathLimit: collected[0]?.pathLimit ?? 0,
      pathCap: collected[0]?.pathCap ?? 0,
    };
  }

  async fontFamilies(): Promise<string[]> {
    await this.#whenReady();
    return this.#fontFamilies;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    const shuttingDown = localError("SHUTTING_DOWN", "the compile pool is closed");
    for (const job of this.#queue.splice(0)) job.fail(shuttingDown);
    for (const waiter of this.#readyWaiters.splice(0)) waiter.no(shuttingDown);

    await Promise.all(
      this.#workers.splice(0).map(
        (worker) =>
          new Promise<void>((resolve) => {
            if (worker.timer) clearTimeout(worker.timer);
            worker.job?.fail(shuttingDown);
            worker.job = undefined;
            if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
              resolve();
              return;
            }
            worker.child.once("exit", () => resolve());
            // Disconnect first so the worker can exit on its own; the kill is
            // a backstop for one that is mid-compile and cannot notice.
            worker.child.disconnect();
            worker.child.kill("SIGKILL");
          }),
      ),
    );
  }

  #spawn(): void {
    const child = fork(WORKER_URL, [], {
      // Structured clone rather than JSON. This channel carries fonts and
      // PDFs; JSON serialization would stringify every byte of them.
      serialization: "advanced",
      // Do **not** inherit the parent's V8 flags. Under `node --test` the
      // parent's execArgv contains `--test`, and inheriting it would make
      // every worker start its own test runner instead of compiling anything.
      execArgv: [],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });

    const worker: Worker = { child, ready: false, job: undefined, timer: undefined };
    this.#workers.push(worker);

    child.on("message", (message: WorkerMessage) => this.#receive(worker, message));
    child.on("exit", () => this.#reap(worker));
    child.on("error", () => {
      /* Surfaced by the `exit` handler; a separate report would double-count. */
    });

    const init: ParentMessage = { type: "init", init: this.#init };
    child.send(init);
  }

  #receive(worker: Worker, message: WorkerMessage): void {
    switch (message.type) {
      case "ready": {
        worker.ready = true;
        this.#fontFamilies = message.fontFamilies;
        for (const waiter of this.#readyWaiters.splice(0)) waiter.ok();
        this.#pump();
        return;
      }
      case "init-failed": {
        this.#fail(new EmquadError(message.failure));
        return;
      }
      case "result": {
        const job = worker.job;
        if (!job || job.id !== message.id) return;
        if (worker.timer) clearTimeout(worker.timer);
        worker.timer = undefined;
        worker.job = undefined;
        job.settle(message.result);
        this.#pump();
        return;
      }
      case "stats-result": {
        this.#statsWaiters.get(message.id)?.(message.stats);
        this.#statsWaiters.delete(message.id);
      }
    }
  }

  #dispatch(worker: Worker, job: PendingJob): void {
    // A worker can be killed between being picked and being written to, so the
    // channel is checked rather than assumed. Sending into a closed channel
    // would strand the job until the `exit` event reported it as a dead worker
    // — a confusing way to learn the pool dispatched to a corpse.
    if (!worker.child.connected) {
      worker.ready = false;
      this.#queue.unshift(job);
      return;
    }

    worker.job = job;
    if (this.#timeoutMs !== undefined) {
      worker.timer = setTimeout(() => this.#expire(worker), this.#timeoutMs);
    }
    const message: ParentMessage = { type: "compile", id: job.id, request: job.request };
    worker.child.send(message);
  }

  #expire(worker: Worker): void {
    const job = worker.job;
    if (!job) return;
    worker.job = undefined;
    worker.timer = undefined;

    // Retire it *before* the kill. The exit is asynchronous, so without this
    // the worker stays in the pool looking idle and ready for the tens of
    // milliseconds it takes to die — long enough for the next compile to be
    // dispatched into a process that no longer exists, which then surfaces as
    // a spurious `WORKER_DIED` on an unrelated document.
    worker.ready = false;

    job.fail(
      localError("WORKER_TIMEOUT", `compile exceeded pool.timeoutMs (${this.#timeoutMs}ms)`),
    );

    // SIGKILL, not SIGTERM. The worker is inside a Rust compile that never
    // returns to the event loop, so it cannot run a signal handler — a
    // catchable signal would simply be ignored.
    worker.child.kill("SIGKILL");
  }

  #reap(worker: Worker): void {
    if (worker.timer) clearTimeout(worker.timer);
    worker.timer = undefined;

    // A job still attached means the worker died holding it — a crash, an OOM
    // kill, or a `#expire` that already reported the timeout and cleared it.
    worker.job?.fail(
      localError("WORKER_DIED", "the worker process exited while compiling this document"),
    );
    worker.job = undefined;

    const index = this.#workers.indexOf(worker);
    if (index !== -1) this.#workers.splice(index, 1);

    if (this.#closed || this.#fatal) return;

    this.#restarts += 1;
    if (this.#restarts > this.#maxRestarts) {
      this.#fail(
        localError(
          "WORKER_START_FAILED",
          `workers died ${this.#restarts} times, exceeding pool.maxRestarts ` +
            `(${this.#maxRestarts}); the pool is giving up rather than respawning forever`,
        ),
      );
      return;
    }
    this.#spawn();
  }

  #fail(error: EmquadError): void {
    if (this.#fatal) return;
    this.#fatal = error;
    for (const job of this.#queue.splice(0)) job.fail(error);
    for (const waiter of this.#readyWaiters.splice(0)) waiter.no(error);
    for (const worker of this.#workers) {
      worker.job?.fail(error);
      worker.job = undefined;
    }
    void this.close();
  }

  #pump(): void {
    for (const worker of this.#workers) {
      if (!worker.ready || worker.job) continue;
      const job = this.#queue.shift();
      if (!job) return;
      this.#dispatch(worker, job);
    }
  }

  #whenReady(): Promise<void> {
    if (this.#fatal) return Promise.reject(this.#fatal);
    if (this.#workers.some((worker) => worker.ready)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.#readyWaiters.push({ ok: resolve, no: reject });
    });
  }

  #askStats(worker: Worker): Promise<Stats> {
    return new Promise((resolve) => {
      const id = (this.#nextId += 1);
      this.#statsWaiters.set(id, resolve);
      const message: ParentMessage = { type: "stats", id };
      worker.child.send(message);
    });
  }
}
