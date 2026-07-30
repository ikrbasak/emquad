/**
 * `@emquad/core` — Typst PDF generation for Node.
 *
 * VFS in, PDF out. Build one {@link Compiler}, keep it, and run documents
 * through it.
 *
 * @packageDocumentation
 */

export { evictCache, setPathLimit, typstVersion } from "#/binding.ts";
export { Compiler } from "#/compiler.ts";
export { DEFAULT_DATA_PATH, Document } from "#/document.ts";
export { EmquadError } from "#/errors.ts";
export type {
  CompileFailure,
  Diagnostic,
  EmquadErrorCode,
  Hint,
  Position,
  Severity,
  TraceFrame,
} from "#/errors.ts";
export type {
  CacheOptions,
  ClockOptions,
  CompileOutput,
  CompilerOptions,
  FileData,
  FontSource,
  PackageFile,
  PageRange,
  PdfOptions,
  PoolMode,
  PoolOptions,
  Stats,
} from "#/types.ts";
