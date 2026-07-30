# API guide

Everything here is exercised by the test suites in `packages/*/test/`.

## Install and compile

```ts
import { Compiler } from "@emquad/core";
import { defaultFonts } from "@emquad/fonts";

const compiler = new Compiler({ fonts: defaultFonts });

const { pdf, pages, warnings } = await compiler.document().source("= Hello").compile();

await compiler.close();
```

`Compiler` is **expensive to construct and cheap to use**: fonts are parsed once, the base VFS is
built once, and the memo cache survives across compiles. Building one per request costs roughly an
order of magnitude. Build it at startup, keep it, close it on shutdown.

`await using compiler = new Compiler(…)` closes it for you.

## The base layer versus the per-document layer

```ts
const compiler = new Compiler({
  fonts: defaultFonts,
  // Built once. Rebuilding per compile would invalidate the memo cache.
  files: {
    "/template.typ": template,
    "/assets/logo.png": defaultLogo,
  },
});

const { pdf } = await compiler
  .document()
  .source('#import "/template.typ": invoice\n#invoice(json("/data.json"))')
  .asset("/assets/logo.png", tenantLogo)   // same path, different bytes
  .data({ number: "INV-1024", total: 42 })
  .compile({ tagged: false });
```

The per-document layer shadows the base layer without disturbing it, so two concurrent documents
can mount different bytes at the same path.

### Paths are canonical. Content is what varies.

Every path here is a **slot**, not a filename.

```ts
// Correct: one path, different bytes per request.
.asset("/assets/logo.png", tenantLogo)

// Wrong: leaks an interned path permanently, aborts the process at ~65k renders.
.asset(`/assets/logo-${tenantId}.png`, tenantLogo)
```

`FileId` is a process-global interner that is never freed and is capped at 65,535. emquad's guard
trips at 50,000 and names the offending *pattern*; watch `(await compiler.stats()).internedPaths`
if you are unsure whether a template is misbehaving.

### Reading `.data()`

`data()` mounts JSON at `/data.json`. Read it with typst's own loader:

```typ
#let data = json("/data.json")
= Invoice #data.number
Total: #data.total
```

Nothing is prepended to your source, which is why this is a file rather than an injected `#let` —
a prelude would shift every line number in every diagnostic.

Pass a second argument for a different path: `.data(value, "/customer.json")`.

## Errors

```ts
import { EmquadError } from "@emquad/core";

try {
  await compiler.document().source(userTemplate).compile();
} catch (error) {
  if (error instanceof EmquadError) {
    error.code;        // "COMPILE_FAILED" — branch on this, never on `message`
    error.file;        // "/main.typ"
    error.line;        // 2
    error.column;      // 6
    error.severity;    // "error"
    error.hints;       // [{ message, position }]
    error.diagnostics; // every diagnostic, in typst's order
    error.summary;     // "/main.typ:2:6: unclosed delimiter" — for logs only
  }
}
```

Real fields, never a formatted string. `summary` is a lossy convenience — do not parse it.

| Code | Means |
|---|---|
| `COMPILE_FAILED` | The document has errors. `diagnostics` holds them. |
| `EXPORT_FAILED` | Typeset fine, PDF export rejected it. |
| `NO_FONTS` | No font parsed. Never reaches you as a blank page. |
| `PATH_VOCABULARY_EXHAUSTED` | Approaching typst's 65,535-path cap. Read the message. |
| `INVALID_PDF_SETTINGS` | e.g. `tagged: true` with `pageRanges`. Caught before compiling. |
| `QUEUE_FULL` | Backpressure. Shed load or retry. |
| `WORKER_TIMEOUT` | Killed by `pool.timeoutMs`. Process mode only. |
| `WORKER_DIED` | A worker exited mid-compile. Process mode only. |
| `INVALID_ARGUMENT` | A caller mistake, caught before the binding. |

### Warnings come back on success

```ts
const { pdf, warnings } = await compiler.document().source(src).compile();
if (warnings.length > 0) log.warn({ warnings }, "document compiled with warnings");
```

Do not discard them. A warning is the most likely place a *silently wrong* document announces
itself — an unmatched font family produces a perfectly valid PDF set in something else, and
nothing about the bytes will tell you.

## Choosing a pool

```ts
new Compiler({ fonts, pool: { mode: "thread", size: 8 } });   // default
new Compiler({ fonts, pool: { mode: "process", size: 8, timeoutMs: 30_000 } });
```

**This is a document-shape decision, not a performance dial.** Measured, release build, M1:

| Pool size | Single page run | Many page runs |
|---|---|---|
| 4 | threads **1.19×** faster | processes **3.83×** faster |
| 8 | threads **1.51×** faster | processes **6.93×** faster |

A page *run* is created by page re-configuration, not by page count — an ordinary document has
exactly one, even at 200 pages. So `"thread"` is the right default and `"process"` is for
documents that repeatedly `#set page(...)`.

Choose `"process"` anyway if you compile **untrusted templates**. It is the only way to survive a
runaway document.

### `pool.timeoutMs` — process mode only, and that is the design

```ts
// Works: the worker is killed, the job rejects with WORKER_TIMEOUT, the pool
// replaces the worker and keeps serving.
new Compiler({ fonts, pool: { mode: "process", timeoutMs: 30_000 } });

// Throws INVALID_ARGUMENT at construction.
new Compiler({ fonts, pool: { timeoutMs: 30_000 } });
```

There is no `timeout` on `compile()` and there cannot be. Typst has no cancellation hook, so in
thread mode a timeout would report failure while the compile ran on forever holding a thread —
protection that is worse than none because it looks real. Refusing at construction is what keeps
the option honest.

### Backpressure

```ts
try {
  await compiler.document().source(src).compile();
} catch (error) {
  if (error.code === "QUEUE_FULL") return reply.status(503).send();
  throw error;
}
```

The queue refuses rather than blocking. Blocking would turn a load spike into unbounded latency
and hide the overload entirely.

## Reproducible output

```ts
const { pdf } = await compiler
  .document()
  .source(src)
  .clock({ fixed: 1_785_888_000, offsetMinutes: 0 })
  .compile({ ident: "invoice-v1", timestamp: 1_785_888_000, creator: false });
```

Two compiles of the same document then produce byte-identical PDFs. Without a pinned clock they
will not — `datetime.today()` and the PDF timestamp move.

`offsetMinutes` is minutes **east** of UTC. JavaScript's `getTimezoneOffset()` returns minutes
west, so pass `-new Date().getTimezoneOffset()`.

## `@preview` packages

```ts
import { Resolver } from "@emquad/resolver";

const source = '#import "@preview/cetz:0.4.2": canvas\n#canvas({})';

const resolver = new Resolver({ lockfile: "typst.lock.json" });
const packages = await resolver.resolve(source);   // transitive

const compiler = new Compiler({ fonts: defaultFonts, packages });
```

Resolve **once at startup**, then keep the compiler. Fifty compiles hit the network zero times
after the first resolve; `resolver.networkFetches` proves it.

Pass every source that might import a package — the document and any templates in your base layer.

### Modes

```ts
new Resolver({ mode: "auto" });                      // memory → disk → network
new Resolver({ mode: "offline" });                   // memory → disk; a miss is a clean error
new Resolver({ mode: "vendor", vendorDir: "./vendor" });  // a checked-in directory only
```

The disk cache defaults to the same location `typst-cli` uses, so a machine that has compiled with
the CLI starts warm.

### Lockfile

```ts
const resolver = new Resolver({ lockfile: "typst.lock.json", updateLockfile: true });
await resolver.resolve(source);
await resolver.save();
```

`updateLockfile` is off by default. A resolver that silently rewrote the lockfile would turn every
integrity mismatch into a lockfile update, which defeats the point. Integrity is verified on
**every disk-cache read**, not only on download, and a mismatched package is never written to
disk.

### Proxies

Node's global `fetch` ignores `HTTPS_PROXY` before Node 24. On Node 24+, set
`NODE_USE_ENV_PROXY=1`. On Node 22, inject one:

```ts
new Resolver({ fetch: myProxyAwareFetch });
```

That option is also how the test suite runs against an in-memory registry with no network.

## Fonts

```ts
import { defaultFonts, fontsFor, fontsExcept, MANIFEST } from "@emquad/fonts";

new Compiler({ fonts: defaultFonts });                             // all 17, 9.3 MB
new Compiler({ fonts: fontsFor("libertinus-serif") });             // 6 faces
new Compiler({ fonts: fontsExcept("new-computer-modern") });       // drop the math family
new Compiler({ fonts: [...defaultFonts, { file: "./Brand.ttf" }] });
new Compiler({ fonts: [...defaultFonts, brandFontBytes] });        // bytes work too
```

Prefer `{ file }` descriptors under `pool.mode: "process"` — the path crosses the IPC channel
instead of the bytes, worth ~23 ms and 77 MB of IPC at eight workers.

**To shrink the payload, drop whole families. Never subset.** `NewCM10-Regular.otf` is
GPL-3.0-or-later and the exception that makes it shippable is void if the glyphs change. See
`LICENSING.md`.

Log what actually parsed at startup:

```ts
console.log(await compiler.fontFamilies());
```

Typst does not lowercase family names, and a near-miss substitutes a font silently rather than
erroring. This list is how you diagnose it.

## Metrics

```ts
const stats = await compiler.stats();
gauge("emquad.paths", stats.internedPaths / stats.pathLimit);
gauge("emquad.queued", stats.queued);
```

Export `internedPaths / pathLimit`. It is the one number that predicts a hard process abort rather
than a degradation, and by the time it matters there is no graceful failure available. Under
`pool.mode: "process"` it reports the worst worker, since the cap is per-process.
