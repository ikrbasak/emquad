// Type-level consumer test.
//
// `tsc` checks this file against the **built** `dist/index.d.ts`, not against
// `src/`. That distinction is the whole point: the declarations are generated
// by tsdown and never hand-written, so nothing else in the repo would notice if
// a rollup dropped an exported type, widened one to `any`, or emitted a
// reference to a path the published package does not contain. `packaging.test.js`
// only asserts the file exists.
//
// A broken `.d.ts` is invisible at runtime and immediate for every TypeScript
// consumer — the exact shape of failure this project keeps finding.
//
// Nothing here executes. It type-checks or it does not.

import { Compiler, EmquadError, type CompileOutput, type PdfOptions } from "../../dist/index.js";

// The constructor's options, including the pool discriminant.
const threaded = new Compiler({ fonts: [new Uint8Array()] });
const pooled = new Compiler({
  fonts: [new Uint8Array()],
  pool: { mode: "process", size: 2, timeoutMs: 1000 },
});

// `timeoutMs` is only meaningful for the process pool. It is a *runtime* error
// in thread mode rather than a type error (hard rule 3 — an option that
// silently did nothing is what that rule forbids), so this must still compile.
const _threadPoolWithoutTimeout = new Compiler({
  fonts: [new Uint8Array()],
  pool: { size: 4 },
});

// The builder chain has to stay chainable through every method, which is the
// thing a declarations rollup is most likely to break by returning `void`.
const doc = threaded
  .document()
  .source("= Hello")
  .file("/a.typ", "x")
  .asset("/logo.png", new Uint8Array())
  .data({ n: 1 })
  .clock({ fixed: 0, offsetMinutes: -new Date().getTimezoneOffset() });

async function check(): Promise<void> {
  const out: CompileOutput = await doc.compile();

  // Buffer, not ArrayBuffer or number[] — consumers index and slice this.
  const _bytes: Buffer = out.pdf;
  const _pages: number = out.pages;
  const _first: string | undefined = out.warnings[0]?.message;

  // `compileSync` exists on the threaded path and returns the same shape.
  const _sync: CompileOutput = threaded.document().source("= Hi").compileSync();

  const opts: PdfOptions = { tagged: false, pageRanges: [{ start: 1 }] };
  await threaded.document().source("= Hi").compile(opts);

  const _families: string[] = await threaded.fontFamilies();
  const stats = await pooled.stats();
  const _cap: number = stats.pathCap;

  await threaded.close();
  await pooled.close();
}

// `EmquadError` must be a real class, so `instanceof` narrows and the
// structured fields are reachable. Formatted strings were rejected deliberately.
function describe(error: unknown): string {
  if (error instanceof EmquadError) {
    const line: number | undefined = error.line;
    return `${error.code} ${error.file ?? "?"}:${line ?? 0} ${error.hints.length}`;
  }
  return "unknown";
}

// `Symbol.asyncDispose` has to survive into the declarations, or `await using`
// stops type-checking for consumers even though it works at runtime.
async function disposable(): Promise<void> {
  const c = new Compiler({ fonts: [new Uint8Array()] });
  const dispose: () => PromiseLike<void> | void = c[Symbol.asyncDispose].bind(c);
  await dispose();
}

export { check, describe, disposable };
