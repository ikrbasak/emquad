# Phase 5 — Benchmarks, Docs, Launch

## 5.1 The Puppeteer comparison

This is the number that drives adoption. It must be defensible, because it will be scrutinized.

- Build **equivalent** documents in both systems — a realistic invoice with a logo, a
  multi-page table with repeating headers, custom fonts, and colors. Not a "hello world",
  which flatters Typst unfairly.
- Measure: cold start, steady-state throughput, RSS at rest and under load, and p99 latency.
- Include Puppeteer's browser launch and page setup honestly. Amortize it across documents the
  way a real pool would, rather than counting it once per PDF.
- Publish the harness alongside the results so anyone can reproduce or dispute them.

**State the caveats plainly.** Typst is not a Chromium replacement — it does not render HTML,
and migrating means rewriting templates in Typst markup. A benchmark that ignores that
migration cost is marketing, not engineering, and the audience for this package will notice.

## 5.2 Honest headline numbers

Re-measure with production-shaped templates before publishing anything. Per
[`../discovery/07-benchmarks.md`](../discovery/07-benchmarks.md), the current 532 µs figure is an
**optimistic bound** — the probe varies only the document title, so sub-document memoization
still helps more than it would in reality.

Never quote the 327 µs memoized figure. It recompiles a byte-identical document and no real
server does that.

## 5.3 Documentation

Priority order, most valuable first:

1. **Quickstart** — install, compile a PDF, in under ten lines.
2. **The path-stability rule** — canonical paths, content varies. This is the one thing users
   must internalize to avoid a production crash. Explain the *why* (the `FileId` interner),
   not just the rule; people follow rules they understand.
3. **Fonts** — registering up front versus at runtime, and why runtime registration is a
   cache-invalidating operation.
4. **Packages and charts** — the two routes from
   [`../discovery/05-fonts-assets-charts.md`](../discovery/05-fonts-assets-charts.md), with
   Route B (pre-rendered SVG) as the default recommendation for typical reports.
5. **Concurrency** — async versus sync, pool sizing, and why we do not use the libuv pool.
6. **Limitations** — no timeouts, trusted templates only, wasm fallback caveats. Put these in
   the README, not buried in a FAQ. Users discovering these in production is worse for the
   project than users declining to adopt.
7. **Migration from Puppeteer** — realistic scope, including what does not translate.

## 5.4 Launch checklist

- Licenses: emquad is MIT, Typst is Apache-2.0, and the **default fonts span four licenses
  including GPL-3.0-or-later** — not "OFL", as previously recorded here. `THIRD-PARTY-NOTICES.md`
  covers the Rust tree automatically; `@emquad/fonts` is manual. See
  [`../../LICENSING.md`](../../LICENSING.md).
- README leads with the function, not the brand — `@emquad/core` is not discoverable on its
  own (see [`../discovery/06-distribution.md`](../discovery/06-distribution.md)).
- `keywords`: `typst`, `pdf`, `pdf-generation`, `puppeteer-alternative`.
- Document the pinned Typst version and expose it at runtime.
- Working examples repo: invoice, report with charts, multi-page table.

## Deliverables

- Reproducible Puppeteer comparison with published harness
- Documentation covering the priority list above
- Examples repo
- Launch-ready READMEs with limitations stated up front
