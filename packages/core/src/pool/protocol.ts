/**
 * The parent/worker wire protocol.
 *
 * Sent over `child_process` IPC with `serialization: "advanced"`, which uses
 * the structured clone algorithm. That choice matters: the default `"json"`
 * serialization would turn every font and every PDF into a base64-ish string
 * round-trip, and this protocol moves megabytes of both.
 */

import type { NativeCompileRequest, NativeCompileResult } from "#/binding.ts";
import type { CompileFailure } from "#/errors.ts";
import type { FileData, FontSource, PackageFile, Stats } from "#/types.ts";

/**
 * What a worker needs to build its own compiler.
 *
 * Note that fonts cross as {@link FontSource}, descriptors included. A worker
 * handed `{ file }` opens the file itself, so the default 9.3 MB font set is
 * never copied down the pipe — 77 MB of IPC avoided at eight workers, worth
 * about 23 ms of startup. Modest, but free.
 */
export interface WorkerInit {
  fonts: FontSource[];
  files: Record<string, FileData> | undefined;
  packages: PackageFile[] | undefined;
  cacheMaxAge: number | boolean | undefined;
  pinRayon: boolean | undefined;
}

export type ParentMessage =
  | { type: "init"; init: WorkerInit }
  | { type: "compile"; id: number; request: NativeCompileRequest }
  | { type: "stats"; id: number };

export type WorkerMessage =
  /** The compiler was built and fonts parsed. Carries what parsed, so the
   *  parent can answer `fontFamilies()` without keeping its own copy. */
  | { type: "ready"; fontFamilies: string[] }
  /** Construction failed. Deterministic, so the pool must not retry it. */
  | { type: "init-failed"; failure: CompileFailure }
  | { type: "result"; id: number; result: NativeCompileResult }
  | { type: "stats-result"; id: number; stats: Stats };
