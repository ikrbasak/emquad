# Fonts, Assets, Tables and Charts

## The layered VFS: load once, override per compile

This is the central architectural pattern. Fonts and shared assets are parsed **once** on a
long-lived `Compiler`; each compile adds a cheap **overlay** that can shadow anything in the
base layer.

```
┌─ Compiler (long-lived, expensive to build) ─────────────┐
│  fonts:  Vec<Font> + FontBook   ← parsed ONCE           │
│  base:   Arc<HashMap<FileId, Bytes>>                    │
│          shared templates, logos, mounted @preview pkgs │
└─────────────────────────────────────────────────────────┘
                          ▲
                          │ Arc clone (cheap)
┌─ Per-compile World ─────┴───────────────────────────────┐
│  overlay: HashMap<FileId, Bytes>   ← small, per request │
│           main.typ + this request's data/assets         │
└─────────────────────────────────────────────────────────┘

World::file(id)  →  overlay.get(id)  ?? base.get(id)  ?? NotFound
```

`World::file` checks the overlay first, then falls back to the base. One hash miss plus one
hash hit — negligible.

### Why this is not just an optimization

**Font parsing is expensive; font handles are cheap.** `Font::iter(Bytes)` parses the file.
`Font` is cheaply cloneable (it holds refcounted `Bytes`). Parsing ~9.3 MB of fonts per
request would dominate a 532 µs compile. Parse once, clone handles per compile.

**More importantly, stability preserves the memo cache.** `book()` returns
`&LazyHash<FontBook>`, and `World` is `#[comemo::track]`ed — so the font book's hash and the
file contents are part of the memoization key. If you rebuild the `FontBook` on every compile,
you **invalidate the memo cache every time** and lose the caching benefit entirely. A stable
base layer is what makes the warm-cache numbers in [07-benchmarks.md](07-benchmarks.md)
achievable.

### Overriding at runtime

Supported and cheap — with one rule imposed by
[footgun #1](02-footguns.md#1-fileid-is-a-leaky-capped-process-global-interner):

> **Override by content at a stable path. Never by inventing new paths.**

```ts
// GOOD — same path, different bytes each request.
//        Interns exactly one FileId, forever.
doc.asset('assets/logo.png', tenantLogoBuffer);

// BAD — new path per tenant. Leaks a FileId permanently,
//       hard-panics the process at ~65k distinct tenants.
doc.asset(`assets/logo-${tenantId}.png`, buf);
```

This is a happy convergence: the ergonomic API and the safe API are the same one. The TS
layer should make the good form natural and the bad form awkward.

### Fonts at runtime: register up front, select per document

Adding a font mutates the `FontBook`, changing its hash and invalidating memoized results.
So:

- **Register all fonts at `Compiler` construction.** This is the fast path.
- **Select per document** with `#set text(font: "…")` — selection is free, registration is not.
- Runtime font registration should be supported but documented as a **cache-invalidating,
  infrequent operation** (tenant onboarding, not per request). Consider having it return a
  new `Compiler` handle rather than mutating in place, to make the cost visible.

## Images

Typst natively supports **PNG, JPEG, GIF, SVG**, and PDF. No extra work is needed — `image()`
resolves through `World::file()`, so anything in the VFS just works. This is why the VFS must
carry binary `Bytes`, not only strings.

**Caveat: SVG text needs fonts — but the real hazard is broader.** Measured in Phase 0
([08-phase-0-results.md](08-phase-0-results.md#missing-fonts-produce-a-silently-blank-pdf-)):

| Scenario | Actual behavior |
|---|---|
| SVG references an **unregistered family**, others available | Falls back correctly ✅ |
| **No fonts registered at all** | Every text run — SVG *and* body — silently dropped |
| Diagnostics in that case | **None.** Compile reports success. |

So the original concern (SVG-specific glyph loss on an unknown family) turned out to be
unfounded: fallback works. The genuine footgun is an **empty `FontBook`**, which is exactly what
a user who skips `@emquad/fonts` gets. It yields a valid, blank PDF with no error and no warning.

**Requirement:** reject an empty font set at `Compiler` construction, and emit a structured
diagnostic when non-empty text resolves zero glyphs. Typst will not tell us; we must check.

Converting SVG text to paths remains good advice for reproducibility, but it is no longer the
primary mitigation.

## Colors

Fully built in: `rgb()`, `luma()`, `cmyk()`, `oklch()`, gradients (linear/radial/conic),
and blend modes. Nothing for us to do. The benchmark document exercises a linear gradient.

## Tables — built in

`#table()` and `#grid()` are core language features. No package, no binary cost. They support
strokes, fills (including per-cell callbacks), alignment, `colspan`/`rowspan`, and
`table.header(...)` rows that **automatically repeat across page breaks**.

That last point is worth calling out: repeating table headers across pages is a perennial
fight in HTML→PDF pipelines. Here it is one line. This is a genuine selling point over
Puppeteer for report and invoice workloads.

## Charts — NOT built in

Typst core has drawing primitives but **no charting**. There are two viable routes:

### Route A — ecosystem packages (`@preview`)

- [`cetz`](https://typst.app/universe/package/cetz/) — TikZ-like vector drawing
- [`cetz-plot`](https://typst.app/universe/package/cetz-plot/) — plots/charts on top of cetz
- [`lilaq`](https://lilaq.org/) — matplotlib-like, stronger for scientific plots

These are registry packages, so they depend on the package resolver
(see [04-packages-and-network.md](04-packages-and-network.md)). Once cached and mounted into
the base VFS layer they cost nothing per compile. `cetz` 0.4.2 is only 126 KB.

### Route B — pre-render to SVG in Node

Generate the chart with any JS charting library, then drop the SVG into the VFS and `image()`
it. Zero packages, zero registry dependency, and reuses charting tools teams already know.

**Recommendation: support both, and document Route B as the default for typical
report/invoice work.** It avoids pulling in the cetz ecosystem and its learning curve for what
is often a single bar chart. Route A is the better answer for dense, document-native
scientific plotting. Remember the SVG-text caveat above applies to Route B.
