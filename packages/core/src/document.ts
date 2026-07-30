import type { CompileBackend } from "#/backend.ts";
import type { NativeCompileRequest } from "#/binding.ts";
import { toNativePdfOptions, unwrap } from "#/convert.ts";
import { localError, normalizeThrown } from "#/errors.ts";
import type { ClockOptions, CompileOutput, FileData, PdfOptions } from "#/types.ts";

/** Where {@link Document.data} mounts its JSON unless told otherwise. */
export const DEFAULT_DATA_PATH = "/data.json";

/**
 * One compile, described.
 *
 * Cheap to create and throw away — it holds a request, not a compiler. Every
 * expensive thing (fonts, the memo cache, the pool) lives on the `Compiler`
 * this came from.
 *
 * ## Paths are canonical; content is what varies
 *
 * Every path-taking method here is a *slot*, not a filename. Typst interns
 * every distinct path in a process-global table that is never freed, is capped
 * at 65,535, and **panics** when exhausted. Naming files per request —
 * `invoice-${uuid}.typ` — therefore leaks permanently and aborts the process
 * at around 65k renders.
 *
 * The safe form is the ergonomic one: `.source(html)` writes to a fixed path
 * every time, and `.asset("/logo.png", tenantLogo)` overrides one stable path
 * with different bytes per tenant. Watch `stats().internedPaths` if you are
 * unsure whether a template is misbehaving.
 */
export class Document {
  readonly #backend: CompileBackend;
  readonly #files: Record<string, FileData> = {};
  #source: string | undefined;
  #main: string | undefined;
  #clock: ClockOptions | undefined;
  #pdf: PdfOptions = {};

  /** @internal Created by {@link Compiler.document}. */
  constructor(backend: CompileBackend) {
    this.#backend = backend;
  }

  /**
   * The main document's source, mounted at `/main.typ`.
   *
   * Nothing is prepended to it. That is a guarantee worth stating: a prelude
   * injected on your behalf would shift every line number in every diagnostic
   * by a constant, and exact positions are most of what makes a compile error
   * useful. It is also why {@link data} mounts a file instead of emitting
   * `#let` bindings.
   */
  source(content: string): this {
    this.#source = content;
    return this;
  }

  /**
   * Use an existing file as the entrypoint instead of {@link source}.
   *
   * The file may come from the compiler's base layer or from {@link file} on
   * this document.
   */
  main(path: string): this {
    this.#main = path;
    return this;
  }

  /**
   * Add or override one file for this compile only.
   *
   * Shadows the compiler's base layer without disturbing it, so two concurrent
   * documents can mount different bytes at the same path.
   */
  file(path: string, data: FileData): this {
    this.#files[path] = data;
    return this;
  }

  /**
   * {@link file}, for things that are not typst source.
   *
   * The only difference is that this rejects a `.typ` path. That check earns
   * its place: mounting a template through `.asset()` works right up until the
   * bytes are binary, and mixing the two up produces a confusing
   * "file not found" rather than an obvious error.
   */
  asset(path: string, data: FileData): this {
    if (path.endsWith(".typ")) {
      throw localError(
        "INVALID_ARGUMENT",
        `asset("${path}") looks like typst source; use .file() for .typ paths`,
      );
    }
    return this.file(path, data);
  }

  /**
   * Mount a JSON value the document can read.
   *
   * Read it with typst's own loader, which turns it into real typst values:
   *
   * ```typ
   * #let data = json("/data.json")
   * = Invoice #data.number
   * ```
   *
   * JSON rather than generated typst source, because generated source would
   * have to be escaped correctly for every possible string a caller passes,
   * and getting that wrong is a template injection. `json()` has no such
   * failure mode.
   */
  data(value: unknown, path: string = DEFAULT_DATA_PATH): this {
    let encoded: string;
    try {
      encoded = JSON.stringify(value);
    } catch (cause) {
      throw localError(
        "INVALID_ARGUMENT",
        `data() value is not JSON-serializable: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        { cause },
      );
    }
    if (encoded === undefined) {
      throw localError("INVALID_ARGUMENT", "data() value serialized to nothing");
    }
    return this.file(path, encoded);
  }

  /**
   * Pin the clock, which is what makes output byte-reproducible.
   *
   * Without this, `datetime.today()` and the PDF's timestamp move, so the same
   * document produces different bytes on every run and no golden-file test can
   * hold.
   */
  clock(options: ClockOptions): this {
    this.#clock = options;
    return this;
  }

  /** Set PDF export options. Merges with anything set by a previous call. */
  pdf(options: PdfOptions): this {
    this.#pdf = { ...this.#pdf, ...options };
    return this;
  }

  /**
   * Compile, off the main thread.
   *
   * Resolves with the PDF and any warnings; throws {@link EmquadError} on
   * failure, with `code`, `file`, `line`, `column`, and `diagnostics` as real
   * fields.
   *
   * There is no `timeout` option, and there cannot be one here: typst has no
   * cancellation hook, so in thread mode a timeout would report a failure
   * while the compile ran on forever. Configure `pool.timeoutMs` with
   * `pool.mode: "process"` instead — a process can actually be killed.
   */
  async compile(options?: PdfOptions): Promise<CompileOutput> {
    const request = this.#request(options);
    try {
      return unwrap(await this.#backend.compile(request));
    } catch (thrown) {
      throw normalizeThrown(thrown);
    }
  }

  /**
   * Compile on the calling thread.
   *
   * Faster than {@link compile} for batch work — N processes each looping over
   * documents — where async scheduling is pure overhead. Unavailable under
   * `pool.mode: "process"`, which has no synchronous path across the process
   * boundary.
   */
  compileSync(options?: PdfOptions): CompileOutput {
    const request = this.#request(options);
    try {
      return unwrap(this.#backend.compileSync(request));
    } catch (thrown) {
      throw normalizeThrown(thrown);
    }
  }

  #request(options?: PdfOptions): NativeCompileRequest {
    if (this.#source === undefined && this.#main === undefined) {
      throw localError(
        "INVALID_ARGUMENT",
        "nothing to compile: call .source(content) or .main(path) first",
      );
    }

    const request: NativeCompileRequest = {};
    if (this.#source !== undefined) request.source = this.#source;
    if (this.#main !== undefined) request.main = this.#main;
    if (Object.keys(this.#files).length > 0) request.files = this.#files;
    if (this.#clock !== undefined) request.clock = this.#clock;

    const pdf = options ? { ...this.#pdf, ...options } : this.#pdf;
    if (Object.keys(pdf).length > 0) request.pdf = toNativePdfOptions(pdf);

    return request;
  }
}
