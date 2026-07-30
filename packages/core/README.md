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

## Related

- [`@emquad/fonts`](https://www.npmjs.com/package/@emquad/fonts) — the default Typst faces
- [`@emquad/resolver`](https://www.npmjs.com/package/@emquad/resolver) — `@preview` packages

## License

MIT. The native binary statically links Typst (Apache-2.0) and ~290 other crates; see
`THIRD-PARTY-NOTICES.md` in this package.
