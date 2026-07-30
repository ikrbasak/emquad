import type { CompileBackend } from "#/backend.ts";
import type { NativeCompilerOptions } from "#/binding.ts";
import { resolveFonts } from "#/convert.ts";
import { Document } from "#/document.ts";
import { localError } from "#/errors.ts";
import { ProcessPool } from "#/pool/process-pool.ts";
import type { WorkerInit } from "#/pool/protocol.ts";
import { ThreadBackend } from "#/thread-backend.ts";
import type { CompilerOptions, Stats } from "#/types.ts";

/**
 * A long-lived compiler.
 *
 * Expensive to construct and cheap to use, which is the whole shape of the
 * API: fonts are parsed once, the base VFS is built once, and the memo cache
 * survives across compiles. Building a `Compiler` per request would invalidate
 * all three and cost roughly an order of magnitude.
 *
 * ```ts
 * const compiler = new Compiler({
 *   fonts: defaultFonts,
 *   files: { "/template.typ": template },
 * });
 *
 * const { pdf, warnings } = await compiler
 *   .document()
 *   .source('#import "/template.typ": invoice\n#invoice(json("/data.json"))')
 *   .data({ number: "INV-1024", total: 42 })
 *   .compile({ tagged: false });
 * ```
 *
 * Call {@link close} when you are done, or use `await using`. It is a no-op in
 * thread mode and required in process mode, where live workers would otherwise
 * keep running.
 */
export class Compiler {
  readonly #backend: CompileBackend;
  #closed = false;

  constructor(options: CompilerOptions) {
    const pool = options.pool ?? {};
    const mode = pool.mode ?? "thread";

    if (options.fonts.length === 0) {
      // The engine rejects this too. Catching it here buys a message that
      // names the option rather than the internal error code, and it is worth
      // stating why the check exists at all: typst compiles *successfully*
      // with no fonts and emits a valid PDF with every text run silently
      // dropped and zero diagnostics. A blank page is the worst possible way
      // to find out.
      throw localError(
        "NO_FONTS",
        "fonts: [] — at least one font is required. Typst would otherwise emit a valid " +
          "PDF with every text run silently dropped and no diagnostics at all.",
      );
    }

    if (pool.timeoutMs !== undefined && mode !== "process") {
      // Refused rather than ignored. In thread mode there is nothing to kill,
      // so honoring this would mean reporting a timeout while the compile ran
      // on forever holding a thread — protection that is worse than none
      // precisely because it looks real.
      throw localError(
        "INVALID_ARGUMENT",
        'pool.timeoutMs requires pool.mode: "process". A compile cannot be cancelled on a ' +
          "thread — typst has no cancellation hook and a Rust thread cannot be killed — so a " +
          "timeout here would report failure while the thread stayed wedged.",
      );
    }

    if (pool.maxRestarts !== undefined && mode !== "process") {
      throw localError(
        "INVALID_ARGUMENT",
        'pool.maxRestarts requires pool.mode: "process"; there are no worker processes to restart',
      );
    }

    this.#backend =
      mode === "process"
        ? new ProcessPool(this.#workerInit(options), pool)
        : new ThreadBackend(this.#nativeOptions(options));
  }

  /**
   * Start describing one compile.
   *
   * Cheap — it allocates a request, nothing more. Create one per document.
   */
  document(): Document {
    if (this.#closed) {
      throw localError("SHUTTING_DOWN", "this Compiler is closed");
    }
    return new Document(this.#backend);
  }

  /**
   * Pool and interner counters.
   *
   * Export `internedPaths / pathLimit`. It is the one number that predicts a
   * hard process abort rather than a degradation, and by the time it matters
   * there is no graceful failure available.
   */
  stats(): Promise<Stats> {
    return this.#backend.stats();
  }

  /**
   * Registered font families, deduplicated and sorted.
   *
   * Worth logging at startup. It is the fastest way to answer why
   * `text(font: "…")` did not match — typst does not lowercase family names,
   * and a near-miss produces a silently substituted font rather than an error.
   */
  fontFamilies(): Promise<string[]> {
    return this.#backend.fontFamilies();
  }

  /** Release the pool. Idempotent. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#backend.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  #nativeOptions(options: CompilerOptions): NativeCompilerOptions {
    const pool = options.pool ?? {};
    const native: NativeCompilerOptions = { fonts: resolveFonts(options.fonts) };

    if (options.files !== undefined) native.files = options.files;
    if (options.packages !== undefined) native.packages = options.packages;
    if (pool.size !== undefined) native.poolSize = pool.size;
    if (pool.queueCapacity !== undefined) native.queueCapacity = pool.queueCapacity;
    if (options.cache?.maxAge !== undefined) native.cacheMaxAge = options.cache.maxAge;
    if (options.pinRayon !== undefined) native.pinRayon = options.pinRayon;

    return native;
  }

  #workerInit(options: CompilerOptions): WorkerInit {
    // Fonts are forwarded *unresolved*. A `{ file }` descriptor crosses the
    // IPC channel as a path and each worker opens the file itself, avoiding
    // 77 MB of startup IPC at eight workers — measured at ~23 ms, which is
    // real but small against the ~80 ms the pool spends spawning and parsing.
    return {
      fonts: options.fonts,
      files: options.files,
      packages: options.packages,
      cacheMaxAge: options.cache?.maxAge,
      pinRayon: options.pinRayon,
    };
  }
}
