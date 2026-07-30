/**
 * Structured diagnostics and the error type built from them.
 *
 * The whole point of this module is that nothing here is a formatted string.
 * A caller branching on why a compile failed must be able to read fields, and
 * a caller rendering the failure must be able to reach positions and hints
 * separately. `message` exists for humans and is never the API.
 */

export type Severity = "error" | "warning";

/** A location in the virtual filesystem. Both numbers are 1-based. */
export interface Position {
  /** A VFS path: `/main.typ`, or `@preview/cetz:0.4.2/lib.typ`. */
  file: string;
  line: number;
  /** Counted in characters, not bytes, so astral-plane text lands correctly. */
  column: number;
}

export interface Hint {
  message: string;
  /**
   * A hint routinely points at different code than the diagnostic it belongs
   * to — the error is where the call failed, the hint is where the parameter
   * was declared. Flattening the two loses the more useful of the pair.
   */
  position: Position | undefined;
}

/** One frame of the import/call chain leading to a diagnostic. */
export interface TraceFrame {
  message: string;
  position: Position | undefined;
}

export interface Diagnostic {
  severity: Severity;
  message: string;
  /** Absent when the diagnostic does not point into any file. */
  position: Position | undefined;
  hints: Hint[];
  trace: TraceFrame[];
}

/**
 * Stable, machine-readable failure codes.
 *
 * Branch on these, never on `message`. Messages are written for humans and are
 * expected to improve; codes are a contract.
 */
export type EmquadErrorCode =
  /** The document has errors. `diagnostics` holds them. */
  | "COMPILE_FAILED"
  /** The document typeset, but PDF export rejected it. */
  | "EXPORT_FAILED"
  /** No font parsed. Never reaches a user as a blank page — see hard rule 8. */
  | "NO_FONTS"
  /** The process is approaching typst's 65,535 interned-path cap. */
  | "PATH_VOCABULARY_EXHAUSTED"
  | "INVALID_PATH"
  | "INVALID_PACKAGE_SPEC"
  | "MAIN_NOT_FOUND"
  | "INVALID_PDF_SETTINGS"
  /** A Rust panic, caught rather than allowed to abort the process. */
  | "PANIC"
  /** Backpressure: the queue is full. Shed load or retry. */
  | "QUEUE_FULL"
  | "SHUTTING_DOWN"
  /** A worker process exited while holding a job. Pool mode only. */
  | "WORKER_DIED"
  /** A worker exceeded `pool.timeoutMs` and was killed. Pool mode only. */
  | "WORKER_TIMEOUT"
  /** The pool could not get a worker to a usable state. */
  | "WORKER_START_FAILED"
  /** A caller mistake this layer caught before reaching the binding. */
  | "INVALID_ARGUMENT";

/** The failure shape the binding returns, and what `EmquadError` is built from. */
export interface CompileFailure {
  code: string;
  message: string;
  diagnostics: Diagnostic[];
}

/**
 * Everything that goes wrong in emquad, as one catchable type.
 *
 * The binding cannot throw this itself. A rejected promise carries only a
 * `napi::Error` — a message and a status, with nowhere to put diagnostics — so
 * the binding *returns* compile failures and this layer converts them. That is
 * also the right place for it: a JS subclass cannot be constructed from Rust.
 */
export class EmquadError extends Error {
  override readonly name: string = "EmquadError";

  /** Branch on this. */
  readonly code: EmquadErrorCode | string;

  /** Every diagnostic, in the order typst reported them. */
  readonly diagnostics: readonly Diagnostic[];

  /**
   * The first diagnostic's location, lifted to the top level because reading
   * `err.line` is what callers actually do. `undefined` when the failure has
   * no position at all — a missing font set, a caught panic, a full queue.
   */
  readonly file: string | undefined;
  readonly line: number | undefined;
  readonly column: number | undefined;
  readonly severity: Severity | undefined;

  /** The first diagnostic's hints. Empty rather than absent. */
  readonly hints: readonly Hint[];

  constructor(failure: CompileFailure, options?: { cause?: unknown }) {
    super(failure.message, options);
    this.code = failure.code;
    this.diagnostics = Object.freeze([...failure.diagnostics]);

    // "First" means the first *error*, falling back to the first diagnostic of
    // any severity. Typst can report a warning ahead of the error that
    // actually stopped the compile, and surfacing the warning's line as
    // `err.line` would point a caller at the wrong place.
    const primary =
      failure.diagnostics.find((d) => d.severity === "error") ?? failure.diagnostics[0];

    this.file = primary?.position?.file;
    this.line = primary?.position?.line;
    this.column = primary?.position?.column;
    this.severity = primary?.severity;
    this.hints = Object.freeze([...(primary?.hints ?? [])]);

    Error.captureStackTrace?.(this, EmquadError);
  }

  /**
   * A one-line `file:line:column: message` summary.
   *
   * Convenience for logs only. It is a lossy view of the fields above, so
   * never parse it — that is what `code` and `diagnostics` are for.
   */
  get summary(): string {
    const where = this.file ? `${this.file}:${this.line}:${this.column}: ` : "";
    return `${where}${this.message}`;
  }
}

/**
 * Normalize anything thrown by the binding into an `EmquadError`.
 *
 * The binding throws for usage mistakes — a bad argument, a full queue — and
 * encodes the code as a `[CODE] ` prefix on the message, because a
 * `napi::Error` has nowhere else to put it. Parsing that prefix here is the
 * only place in this codebase that reads a code out of a string; everything
 * downstream sees a real field.
 */
export function normalizeThrown(thrown: unknown): EmquadError {
  if (thrown instanceof EmquadError) return thrown;

  const message = thrown instanceof Error ? thrown.message : String(thrown);
  const match = /^\[([A-Z_]+)\]\s*(.*)$/su.exec(message);

  return new EmquadError(
    {
      code: match?.[1] ?? "INVALID_ARGUMENT",
      message: match?.[2] ?? message,
      diagnostics: [],
    },
    { cause: thrown },
  );
}

/** Build an `EmquadError` for a failure this layer detected itself. */
export function localError(
  code: EmquadErrorCode,
  message: string,
  options?: { cause?: unknown },
): EmquadError {
  return new EmquadError({ code, message, diagnostics: [] }, options);
}
