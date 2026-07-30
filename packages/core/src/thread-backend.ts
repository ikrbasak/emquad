import type { CompileBackend } from "#/backend.ts";
import type {
  NativeCompilerOptions,
  NativeCompileRequest,
  NativeCompileResult,
} from "#/binding.ts";
import { NativeCompiler } from "#/binding.ts";
import { normalizeThrown } from "#/errors.ts";
import type { Stats } from "#/types.ts";

/**
 * Compiles on the Rust thread pool inside this process.
 *
 * The default. It has no startup cost beyond parsing fonts once, no IPC, and
 * hands PDFs back without copying them. What it cannot do is escape typst's
 * process-global state — see {@link ProcessPool} for when that matters.
 */
export class ThreadBackend implements CompileBackend {
  readonly #native: NativeCompiler;

  constructor(options: NativeCompilerOptions) {
    try {
      this.#native = new NativeCompiler(options);
    } catch (thrown) {
      // `NO_FONTS` arrives here, and arriving *here* is the point: a font
      // problem must never reach a user as a blank page.
      throw normalizeThrown(thrown);
    }
  }

  compile(request: NativeCompileRequest): Promise<NativeCompileResult> {
    return this.#native.compile(request);
  }

  compileSync(request: NativeCompileRequest): NativeCompileResult {
    return this.#native.compileSync(request);
  }

  stats(): Promise<Stats> {
    return Promise.resolve(this.#native.stats);
  }

  fontFamilies(): Promise<string[]> {
    return Promise.resolve(this.#native.fontFamilies);
  }

  close(): Promise<void> {
    // Nothing to do. The Rust pool's threads are detached OS threads rather
    // than libuv workers, so they do not hold Node's event loop open and the
    // process exits normally without an explicit shutdown.
    return Promise.resolve();
  }
}
