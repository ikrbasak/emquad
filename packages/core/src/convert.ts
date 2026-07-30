import { readFileSync } from "node:fs";

import type { NativeCompileResult, NativeDiagnostic, NativePdfOptions } from "#/binding.ts";
import type { CompileFailure, Diagnostic, Hint, Severity, TraceFrame } from "#/errors.ts";
import { EmquadError, localError } from "#/errors.ts";
import type { CompileOutput, FontSource, PdfOptions } from "#/types.ts";

/**
 * Read every font that was given as a file descriptor.
 *
 * Synchronous on purpose. This runs once, at `Compiler` construction, and
 * making it async would force the constructor to be a factory function for no
 * benefit — the alternative is a `Compiler` that exists but is not yet usable,
 * which is a worse thing to hand a caller.
 */
export function resolveFonts(sources: readonly FontSource[]): Uint8Array[] {
  return sources.map((source, index) => {
    if (source instanceof Uint8Array) return source;
    try {
      return readFileSync(source.file);
    } catch (cause) {
      throw localError(
        "INVALID_ARGUMENT",
        `could not read font at fonts[${index}] (${source.file}): ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        { cause },
      );
    }
  });
}

export function toNativePdfOptions(pdf: PdfOptions): NativePdfOptions {
  // Built key by key rather than spread. `exactOptionalPropertyTypes` draws a
  // real distinction between an absent field and one set to `undefined`, and
  // the napi boundary honors it: an explicit `undefined` is a present property
  // with no value, which is not what "leave it at the default" means.
  const out: NativePdfOptions = {};
  if (pdf.tagged !== undefined) out.tagged = pdf.tagged;
  if (pdf.pretty !== undefined) out.pretty = pdf.pretty;
  if (pdf.standards !== undefined) out.standards = pdf.standards;
  if (pdf.ident !== undefined) out.ident = pdf.ident;
  if (pdf.creator !== undefined) out.creator = pdf.creator;
  if (pdf.timestamp !== undefined) out.timestamp = pdf.timestamp;
  if (pdf.pageRanges !== undefined) {
    out.pageRanges = pdf.pageRanges.map((range) => {
      const mapped: { start?: number; end?: number } = {};
      if (range.start !== undefined) mapped.start = range.start;
      if (range.end !== undefined) mapped.end = range.end;
      return mapped;
    });
  }
  return out;
}

function toPosition(position: NativeDiagnostic["position"]) {
  return position === undefined || position === null ? undefined : position;
}

function toDiagnostic(source: NativeDiagnostic): Diagnostic {
  return {
    // The binding types this as `string` because napi has no sum types. It is
    // only ever `"error"` or `"warning"` — see `emquad_engine::Severity`.
    severity: source.severity as Severity,
    message: source.message,
    position: toPosition(source.position),
    hints: source.hints.map(
      (hint): Hint => ({ message: hint.message, position: toPosition(hint.position) }),
    ),
    trace: source.trace.map(
      (frame): TraceFrame => ({ message: frame.message, position: toPosition(frame.position) }),
    ),
  };
}

export function toDiagnostics(source: readonly NativeDiagnostic[]): Diagnostic[] {
  return source.map((entry) => toDiagnostic(entry));
}

/**
 * Turn the binding's discriminated result into a value or a thrown
 * `EmquadError`.
 *
 * This is the conversion Phase 2 deliberately left to this layer: the binding
 * returns failures because a rejected promise can only carry a `napi::Error`,
 * and a JS `Error` subclass cannot be constructed from Rust at all.
 */
export function unwrap(result: NativeCompileResult): CompileOutput {
  if (result.ok && result.pdf) {
    return {
      pdf: result.pdf,
      pages: result.pages ?? 0,
      warnings: toDiagnostics(result.warnings),
    };
  }

  const failure: CompileFailure = result.error
    ? {
        code: result.error.code,
        message: result.error.message,
        diagnostics: toDiagnostics(result.error.diagnostics),
      }
    : {
        // Unreachable through the binding, which always populates one branch
        // or the other. Reported rather than assumed away, because the
        // alternative is a `TypeError` on `undefined` three frames later.
        code: "PANIC",
        message: "the binding returned neither a PDF nor an error",
        diagnostics: [],
      };

  throw new EmquadError(failure);
}
