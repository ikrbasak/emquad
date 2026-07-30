/**
 * The worker-process entry point.
 *
 * Forked by {@link ProcessPool}, one per pool slot. Each worker owns a private
 * `Compiler` — its own fonts, its own base VFS, its own `comemo` cache — which
 * is the entire reason this file exists. Everything process-global in typst is
 * global *to this process*, so the contention that flattens the thread pool on
 * multi-page-run documents does not cross between workers.
 *
 * Compiles run through `compileSync`. Handing a job to the Rust thread pool
 * from in here would add a scheduling hop to a process that has exactly one
 * job at a time and nothing else to do while it waits.
 */

import { NativeCompiler } from "#/binding.ts";
import { resolveFonts } from "#/convert.ts";
import type { NativeCompilerOptions } from "#/binding.ts";
import type { ParentMessage, WorkerInit, WorkerMessage } from "#/pool/protocol.ts";

let compiler: NativeCompiler | undefined;

function send(message: WorkerMessage): void {
  // `process.send` is only defined when the process was forked with an IPC
  // channel. If it is missing, this file was run directly and there is nobody
  // to talk to.
  process.send?.(message);
}

function build(init: WorkerInit): void {
  const options: NativeCompilerOptions = { fonts: resolveFonts(init.fonts) };
  if (init.files !== undefined) options.files = init.files;
  if (init.packages !== undefined) options.packages = init.packages;
  if (init.cacheMaxAge !== undefined) options.cacheMaxAge = init.cacheMaxAge;
  if (init.pinRayon !== undefined) options.pinRayon = init.pinRayon;

  // One compile thread. The worker never has more than one job in flight, so
  // a larger pool inside it would only reintroduce the in-process contention
  // this whole design exists to avoid.
  options.poolSize = 1;

  compiler = new NativeCompiler(options);
  send({ type: "ready", fontFamilies: compiler.fontFamilies });
}

/**
 * Reshape a thrown binding error into a failure envelope.
 *
 * `diagnostics` is typed as the empty tuple rather than an array so the result
 * satisfies both this package's `CompileFailure` and the binding's — they
 * differ only in whether `position` may be `undefined`, and an empty list
 * satisfies either.
 */
function failure(thrown: unknown): { code: string; message: string; diagnostics: [] } {
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  const match = /^\[([A-Z_]+)\]\s*(.*)$/su.exec(message);
  return {
    code: match?.[1] ?? "WORKER_START_FAILED",
    message: match?.[2] ?? message,
    diagnostics: [],
  };
}

process.on("message", (message: ParentMessage) => {
  try {
    switch (message.type) {
      case "init": {
        build(message.init);
        return;
      }
      case "compile": {
        if (!compiler) throw new Error("[WORKER_START_FAILED] worker received a job before init");
        send({ type: "result", id: message.id, result: compiler.compileSync(message.request) });
        return;
      }
      case "stats": {
        if (!compiler) throw new Error("[WORKER_START_FAILED] worker is not initialized");
        send({ type: "stats-result", id: message.id, stats: compiler.stats });
      }
    }
  } catch (thrown) {
    if (message.type === "init") {
      send({ type: "init-failed", failure: failure(thrown) });
      return;
    }
    // A throw from `compileSync` is a usage error, not a compile outcome —
    // compile failures come back as `{ ok: false }`. Reshape it into the same
    // envelope so the parent has one path to handle rather than two.
    if (message.type === "compile") {
      send({
        type: "result",
        id: message.id,
        result: { ok: false, warnings: [], error: failure(thrown) },
      });
    }
  }
});

// Nothing else keeps this process alive: the IPC channel is the only handle.
// It closes when the parent disconnects, and the worker exits on its own.
process.on("disconnect", () => {
  process.exit(0);
});
