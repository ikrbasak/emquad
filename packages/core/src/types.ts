import type { Diagnostic } from "#/errors.ts";

/**
 * The contents of one virtual file. A `string` is text; bytes are bytes.
 *
 * Note the asymmetry with {@link FontSource}, which is deliberate: here a
 * string is *content*, because most VFS files are `.typ` source. A font is
 * never text, so there a string would be meaningless and the path form is
 * spelled out instead.
 */
export type FileData = string | Uint8Array;

/**
 * A font, either as bytes or as a file for emquad to read.
 *
 * Prefer `{ file }` when the font is on disk. Under
 * {@link PoolOptions | process pooling} the descriptor is what crosses the
 * process boundary, so each worker opens the file itself rather than receiving
 * a copy of the bytes.
 *
 * Measured, so it is not oversold: with the 9.3 MB default set and eight
 * workers, descriptors cut pool startup from ~103 ms to ~80 ms and avoid 77 MB
 * of IPC. Worth taking, but startup is dominated by spawning the processes and
 * parsing the fonts in each — neither of which the descriptor form avoids. At
 * one or two workers the two forms are indistinguishable.
 */
export type FontSource = Uint8Array | { file: string };

/** One file belonging to a resolved `@preview` package. */
export interface PackageFile {
  /** e.g. `@preview/cetz:0.4.2` */
  spec: string;
  /**
   * Path within the package.
   *
   * **Include `typst.toml`.** Typst reads the manifest to find the package
   * entrypoint; without it an import fails with a file-not-found error naming
   * a file the user never wrote.
   */
  path: string;
  data: FileData;
}

/** Controls what `datetime.today()` and the PDF timestamp see. */
export interface ClockOptions {
  /**
   * Unix seconds. Pins the date, which is what makes output byte-reproducible
   * — a moving clock changes the PDF even when the document does not.
   */
  fixed?: number;
  /**
   * Minutes **east** of UTC.
   *
   * Note the sign. JavaScript's `Date#getTimezoneOffset()` returns minutes
   * *west*, so pass `-new Date().getTimezoneOffset()`.
   */
  offsetMinutes?: number;
  /** Make `datetime.today()` an error inside the document rather than a date. */
  unavailable?: boolean;
}

/** A 1-based, inclusive page range. */
export interface PageRange {
  /** Omit for "from the first page". */
  start?: number;
  /** Omit for "to the last page". */
  end?: number;
}

export interface PdfOptions {
  /**
   * Emit a tagged (accessible) PDF. Defaults to `true`, matching typst.
   *
   * The cost is size, not time: Phase 0 measured up to +302% output bytes
   * against +5–28% compile time. Turn it off for machine-consumed PDFs, leave
   * it on for anything a person might open with a screen reader.
   */
  tagged?: boolean;
  pretty?: boolean;
  /** Standard names: `1.4`–`2.0`, `a-1b`…`a-4e`, `ua-1`. */
  standards?: string[];
  /** Requires `tagged: false`. Rejected before compiling, not after. */
  pageRanges?: PageRange[];
  /** Must be stable across compiles of the same document, or omitted entirely. */
  ident?: string;
  /** A string, or `false` to omit the field. */
  creator?: string | false;
  /** Unix seconds, or `false` to omit the timestamp. */
  timestamp?: number | false;
}

/**
 * How compiles are executed.
 *
 * `"thread"` runs them on a Rust thread pool inside this process. `"process"`
 * runs them in separate Node processes. The choice is not a micro-optimization
 * — see {@link PoolOptions}.
 */
export type PoolMode = "thread" | "process";

export interface PoolOptions {
  /**
   * Default `"thread"`.
   *
   * Choose `"process"` for either of two measured reasons:
   *
   * - **Documents with many page runs collapse under threads.** Phase 0
   *   measured 0.46× at eight threads where separate processes reached 5.18×.
   *   Phase 2 ruled out the obvious cause — confining typst's internal rayon
   *   does not help — which places the contention process-global, most likely
   *   in `comemo`'s cache. Threads cannot escape it; processes can.
   * - **Untrusted templates.** Typst has no cancellation hook and a Rust
   *   thread cannot be killed, so a runaway document wedges a thread forever.
   *   A process can be killed, in 22–35 ms. This is the only real mitigation,
   *   and it is why {@link timeoutMs} exists here and nowhere else.
   *
   * The cost is startup and IPC: every worker parses its own fonts and holds
   * its own memo cache, and every request and PDF is copied across a process
   * boundary.
   */
  mode?: PoolMode;

  /** Workers, or threads. Defaults to `availableParallelism()`. */
  size?: number;

  /**
   * Queue depth before a compile is *refused* rather than queued.
   *
   * Refusing is deliberate. Blocking would convert a load spike into unbounded
   * latency and hide the overload; a `QUEUE_FULL` error lets the caller shed
   * load. Default 1024.
   */
  queueCapacity?: number;

  /**
   * Kill a worker whose compile exceeds this many milliseconds.
   *
   * **`"process"` mode only, and that restriction is the whole design.** In
   * thread mode there is nothing to kill, so a timeout would report a failure
   * while the thread stayed wedged forever — protection that is worse than
   * none, because it looks real. Setting this without `mode: "process"` is an
   * error rather than a no-op.
   *
   * Omit it to let compiles run to completion.
   */
  timeoutMs?: number;

  /**
   * How many times a worker may be replaced after dying before the pool gives
   * up and fails every subsequent compile. Default 10. Process mode only.
   *
   * A worker that dies on startup — a missing native binding, an unparsable
   * font — would otherwise respawn forever and turn a configuration mistake
   * into an invisible busy loop.
   */
  maxRestarts?: number;
}

export interface CacheOptions {
  /**
   * `comemo` eviction age, or `false` to disable eviction entirely.
   *
   * Defaults to 16, which Phase 0 measured at −5.9% throughput while bounding
   * RSS to ~40 MB against ~1 GB unbounded. Disabling it is only sane for
   * short-lived processes.
   *
   * **The cache is process-global.** Two `Compiler` instances in one process
   * share it and do not isolate each other; this setting belongs to whichever
   * pool actually runs the compile.
   */
  maxAge?: number | false;
}

export interface CompilerOptions {
  /**
   * At least one font must parse.
   *
   * An empty set is a hard error rather than a default, because typst compiles
   * happily without fonts and emits a valid PDF with **every text run silently
   * dropped and no diagnostics at all**. A blank page is the worst possible
   * way to learn about a font problem.
   */
  fonts: FontSource[];

  /**
   * The shared base VFS layer: templates, logos, data that does not vary per
   * request.
   *
   * Built once. Rebuilding it per compile would invalidate the memo cache and
   * destroy throughput, which is the reason `Compiler` is long-lived at all.
   */
  files?: Record<string, FileData>;

  /**
   * Resolved `@preview` package files. Fetching them belongs to
   * `@emquad/resolver`; this layer only stores what it is handed.
   */
  packages?: PackageFile[];

  pool?: PoolOptions;
  cache?: CacheOptions;

  /**
   * Confine typst's internal rayon to one thread per compile.
   *
   * **Default `false`, and leave it there.** Phase 0 measured the environment
   * variable form as worth 29–43% on multi-page-run documents; Phase 2
   * measured this in-process equivalent under a real pool and found no benefit
   * at any size plus ~15% cost at low concurrency. The knob survives only
   * because the two measurements have not been reconciled.
   */
  pinRayon?: boolean;
}

/**
 * A successful compile.
 *
 * Warnings ride along with success rather than being dropped, because a
 * warning is the most likely place a silently-wrong document announces itself
 * — an unmatched font family, an SVG whose glyphs went missing. Nothing else
 * about the PDF will tell you.
 */
export interface CompileOutput {
  pdf: Buffer;
  pages: number;
  warnings: Diagnostic[];
}

/** Pool and interner counters, for metrics. */
export interface Stats {
  poolSize: number;
  queueCapacity: number;
  /** Jobs waiting, not counting those in flight. */
  queued: number;
  /**
   * Distinct VFS paths interned process-wide, including those typst interned
   * on its own while resolving imports.
   *
   * **This is the number that predicts a crash.** Export
   * `internedPaths / pathLimit` and alert on it; the failure mode it warns
   * about is a hard process abort at ~65k, not a degradation.
   */
  internedPaths: number;
  /** Paths interned through emquad's wrapper. Never exceeds `internedPaths`. */
  trackedPaths: number;
  /** Where emquad's guard trips. */
  pathLimit: number;
  /** Typst's hard cap, past which it panics. */
  pathCap: number;
}
