# @emquad/core

Typst PDF generation for Node. **Virtual filesystem in → PDF out.**

```sh
npm install @emquad/core @emquad/fonts
```

```ts
import { Compiler } from "@emquad/core";
import { defaultFonts } from "@emquad/fonts";

const compiler = new Compiler({ fonts: defaultFonts });

const { pdf, pages, warnings } = await compiler
  .document()
  .source('#let d = json("/data.json")\n= Invoice #d.number')
  .data({ number: "INV-1024" })
  .compile({ tagged: false });

await compiler.close();
```

Requires **Node ≥ 22**. ESM only.

## `Compiler` is long-lived

Expensive to construct, cheap to use: fonts are parsed once, the base VFS is built once, and the
memo cache survives across compiles. Building one per request costs roughly an order of
magnitude. Build it at startup and keep it.

```ts
const compiler = new Compiler({
  fonts: defaultFonts,
  files: { "/template.typ": template },   // shared base layer, built once
  pool: { size: 8 },
});
```

## Paths are canonical; content is what varies

Every path is a **slot**, not a filename.

```ts
.asset("/logo.png", tenantLogo)            // correct
.asset(`/logo-${tenantId}.png`, logo)      // leaks, and crashes at ~65k renders
```

Typst interns every distinct virtual path in a process-global table that is never freed and is
capped at 65,535. Override by *content* at a *stable* path. Watch
`(await compiler.stats()).internedPaths` if you are unsure.

## Errors are structured

```ts
import { EmquadError } from "@emquad/core";

try {
  await compiler.document().source(template).compile();
} catch (error) {
  if (error instanceof EmquadError) {
    error.code;        // "COMPILE_FAILED" — branch on this, never on `message`
    error.file;        // "/main.typ"
    error.line;        // 2
    error.column;      // 6
    error.hints;       // [{ message, position }]
    error.diagnostics; // all of them, in typst's order
  }
}
```

**Do not discard `warnings`.** They come back on *success*, and a warning is the most likely
place a silently-wrong document announces itself — an unmatched font family yields a perfectly
valid PDF set in something else.

## Two ways a PDF comes out wrong without failing

PDF generation fails silently more often than it crashes, and both of these produce a valid PDF,
the right page count, a successful compile, and nothing thrown.

**An empty font set drops every text run.** Typst compiles it happily and emits a blank page with
zero diagnostics, so `Compiler` rejects `fonts: []` at construction rather than letting it reach
you as an empty document. You cannot turn this check off.

**SVG text in an unregistered family can vanish entirely.** Typst emits *no diagnostic at all*
for an SVG whose `font-family` is not registered — not an error, not a warning. With a serif
family present the text is substituted; with only a monospace family registered the text renders
as nothing whatsoever. Ordinary `#set text(font: …)` does warn, but SVG is not on that code path,
so no check can catch it. **Register a serif family** if any of your input is SVG, which includes
every pre-rendered chart.

Neither is theoretical — both were found by rasterizing output and comparing images, after tests
that asserted "no error thrown" passed.

## Choosing a pool

```ts
new Compiler({ fonts, pool: { mode: "thread" } });   // default
new Compiler({ fonts, pool: { mode: "process", timeoutMs: 30_000 } });
```

This is a **document-shape decision**, not a performance dial. A page *run* is created by page
re-configuration, not page count — an ordinary document has exactly one, even at 200 pages.

| | Single page run | Many page runs |
|---|---|---|
| 4 workers | threads 1.19× faster | processes **3.83×** faster |
| 8 workers | threads 1.51× faster | processes **6.93×** faster |

Choose `"process"` for documents that repeatedly `#set page(...)`, and always for **untrusted
templates** — typst has no cancellation hook, so a runaway document wedges a thread forever.
`pool.timeoutMs` kills a worker process and is available only in that mode; setting it on the
thread pool is a construction error rather than a no-op, because a timeout that cannot interrupt
anything is worse than none.

## Reproducible output

```ts
await compiler
  .document()
  .source(src)
  .clock({ fixed: 1_785_888_000, offsetMinutes: 0 })
  .compile({ ident: "invoice-v1", timestamp: 1_785_888_000, creator: false });
```

Without a pinned clock the same document produces different bytes on every run.
`offsetMinutes` is minutes **east** of UTC — JavaScript's `getTimezoneOffset()` returns the
opposite sign.

## Fonts: register up front, select per document

Registration is expensive; selection is free.

```ts
const compiler = new Compiler({ fonts: [...defaultFonts, corporateSans] });

// Per document, costs nothing:
.source('#set text(font: "Corporate Sans")\n= Hello')
```

Adding a font mutates the font book, which changes its hash and **invalidates the memo cache** —
every document compiled afterwards starts cold. Registering at runtime is supported, but treat it
as a tenant-onboarding operation rather than a per-request one. Registering per request costs
roughly an order of magnitude and is the single most common way to make this library slow.

`@emquad/fonts` is 9.3 MB for 17 faces. `fontsExcept()` drops whole families if that matters;
do not subset the files themselves, which would relicense them.

## Charts

Typst has drawing primitives but no charting. Two routes:

**Pre-render to SVG in Node** (recommended for reports and invoices). Generate the chart with any
JS charting library, put the SVG in the VFS, and `image()` it. No registry dependency, and it
reuses tooling your team already has. Mind the SVG-text caveat above — register a serif family.

**`@preview` packages** (`cetz`, `cetz-plot`, `lilaq`) via
[`@emquad/resolver`](https://www.npmjs.com/package/@emquad/resolver). Better for dense,
document-native scientific plotting. Once cached and mounted into the base VFS layer they cost
nothing per compile.

## Concurrency

`compile()` runs on a dedicated Rust thread pool, **not** libuv's. That is deliberate:
`UV_THREADPOOL_SIZE` defaults to 4 and is shared with `fs`, DNS, and `crypto`, so building on it
would silently cap a server at four concurrent renders *and* stall unrelated file reads, with no
symptom pointing here.

`compileSync()` exists for CLIs, build scripts, and batch jobs, where blocking the main thread is
free and pool setup is not. It is refused in process mode, where it cannot preserve isolation.

Size the pool to cores, not to request concurrency — the queue absorbs bursts and **refuses**
rather than blocking when full, so overload surfaces as a `QUEUE_FULL` error you can shed load
on instead of as unbounded latency. Past 4 threads, gains on ordinary documents are small.

## Limitations

Stated up front, because finding these in production is worse than declining to adopt.

- **No compile timeout in thread mode.** Typst has no cancellation hook and a Rust thread cannot
  be killed, so a timeout there could only leak a wedged thread while looking like protection.
  `pool.timeoutMs` exists only for `mode: "process"`, where killing actually works.
- **Untrusted templates require `mode: "process"`.** A malicious or merely runaway template can
  loop or allocate without bound. Process isolation is the only real containment.
- **This is not an HTML renderer.** Migrating from Chromium means rewriting templates in Typst
  markup. There is no HTML input path, and that cost is real — see below.
- **Typst is pre-1.0**, so output can change between versions. See below.
- **~30 MB installed**, one prebuilt binary per platform. No compiler needed, but it is not small.
- **Eight platforms**, verified end to end on `darwin-arm64` so far.

## Typst versions

This release compiles with **Typst 0.15.1**, pinned exactly and statically linked — the compiler
is inside the binary, so there is no way to pair a given emquad with a different typst.

```ts
import { typstVersion } from "@emquad/core";

typstVersion(); // "0.15.1"
```

Record it alongside any golden file or visual baseline you keep: typst's output changes between
releases, so it is the first thing to check when a document renders differently. **A typst minor
bump is a minor bump of this package**, noted in the changelog and never automatic.

## Against Puppeteer

Measured on equivalent documents — same page size, same table, same font, same embedded logo —
on an M1, at 4 workers. The harness is published in the repository so this can be checked or
disputed.

| Document | emquad | Puppeteer | |
|---|---|---|---|
| Invoice, 1 page | 1,312 docs/s | 51 docs/s | **25×** |
| Report, 4–5 pages, 120 rows | 104 docs/s | 40 docs/s | **2.6×** |
| RSS under load | 92 MiB | 1,445 MiB | **16× less** |
| Cold start | 78 ms | 661 ms | |
| p99 latency (invoice) | 4.8 ms | 97.4 ms | |

**The ratio depends entirely on the document, so take the second row as the honest one for
report-shaped work.** Chromium's per-document fixed cost — `setContent`, style recalculation, the
print path — is what emquad avoids, so the advantage is largest on small documents and narrows as
real typesetting comes to dominate. Normalized per page, the report row is ~2.1×.

The memory difference is usually the one that changes decisions: **an idle Chromium costs more
than emquad under full load.** That is what sizes your containers.

## Migrating from Puppeteer

Realistically: the pipeline gets simpler and faster, and the templates get rewritten.

What carries over — your data layer, and charts if you pre-render them to SVG. What does not —
HTML and CSS. Typst markup is a different language, and a nontrivial invoice template is a
day's work, not an afternoon's. Budget for that rather than for a drop-in swap.

What you stop maintaining: a Chromium install in your image, browser-crash recovery, and
`page.setContent` timing races.

## Examples

Runnable, in [`examples/`](https://github.com/ikrbasak/emquad/tree/main/examples): a data-driven
invoice, a report with an SVG chart, and a 400-row table spanning pages. Each one demonstrates a
rule from above in code rather than prose.

## Related

- [`@emquad/fonts`](https://www.npmjs.com/package/@emquad/fonts) — the default Typst faces
- [`@emquad/resolver`](https://www.npmjs.com/package/@emquad/resolver) — `@preview` packages

## License

MIT. The native binary statically links Typst (Apache-2.0) and ~290 other crates; see
`THIRD-PARTY-NOTICES.md` in this package.
