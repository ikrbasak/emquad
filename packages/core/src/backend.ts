import type { NativeCompileRequest, NativeCompileResult } from "#/binding.ts";
import type { Stats } from "#/types.ts";

/**
 * What a document builder needs in order to run a compile.
 *
 * Two implementations: the Rust thread pool in this process, and a pool of
 * Node worker processes. Keeping the builder behind this interface is what
 * lets `pool.mode` be a one-word configuration change rather than a different
 * API.
 */
export interface CompileBackend {
  compile(request: NativeCompileRequest): Promise<NativeCompileResult>;

  /**
   * Compile on the calling thread.
   *
   * The process backend cannot honor this — there is no synchronous way to
   * round-trip a request through another process — and throws rather than
   * quietly blocking or falling back to an in-process compile that would not
   * have the isolation the caller asked for.
   */
  compileSync(request: NativeCompileRequest): NativeCompileResult;

  stats(): Promise<Stats>;
  fontFamilies(): Promise<string[]>;
  close(): Promise<void>;
}
