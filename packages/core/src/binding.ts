/**
 * The single seam onto the native addon.
 *
 * Every other module in this package imports the binding through here, so that
 * Phase 4 can change *how* the addon is located — vendoring the generated
 * loader and depending on `@emquad/typst-binding-<platform>` optional
 * packages — by editing one file. `@emquad/binding` is internal to this repo
 * and is never published, so this import cannot survive to a release as-is.
 */

export {
  Compiler as NativeCompiler,
  evictCache,
  setPathLimit,
  typstVersion,
} from "@emquad/binding";

export type {
  ClockOptions as NativeClockOptions,
  CompileRequest as NativeCompileRequest,
  CompileResult as NativeCompileResult,
  CompilerOptions as NativeCompilerOptions,
  Diagnostic as NativeDiagnostic,
  PackageFile as NativePackageFile,
  PdfOptions as NativePdfOptions,
} from "@emquad/binding";
