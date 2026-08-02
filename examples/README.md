# Examples

Runnable, and each one exists to demonstrate a rule that is expensive to learn from production.

```sh
pnpm install
pnpm build            # the examples import the built packages
cd examples
pnpm all              # or: node 01-invoice.js
```

PDFs land in `out/`. Open them — several of the failure modes this library guards against are
invisible unless you look at the page.

| Example | Shows |
|---|---|
| [`01-invoice.js`](01-invoice.js) | JSON → PDF, a shared template in the base layer, and **canonical asset paths** |
| [`02-report-with-chart.js`](02-report-with-chart.js) | Charts as pre-rendered SVG, and the **silent SVG-font trap** |
| [`03-multi-page-table.js`](03-multi-page-table.js) | Repeating table headers across pages, and **which pool to pick** |

These are workspace members, so they `import { Compiler } from "@emquad/core"` — the same
specifier your code writes. Importing `../packages/core/dist` would have made them run while
demonstrating something nobody can copy.

## The three things worth taking away

**Paths are slots; content is what varies.** `01` overrides `/logo.png` by *content* at a stable
path. Writing `` `/logo-${tenantId}.png` `` instead interns a new path in a process-global table
that is never freed and is capped at 65,535 — it leaks permanently and aborts the process at
around 65k renders. `03` prints `internedPaths` after 400 rows to show it stays at 1.

**SVG text in an unregistered font family fails silently.** `02` puts `font-family="Libertinus
Serif"` in its chart because that family is registered. Name one that is not and typst emits *no
diagnostic at all* — with only a monospace family available the labels render as nothing, and you
get a valid PDF with a wordless chart. Ordinary `#set text(font: …)` warns; SVG is not on that
path.

**Pool mode is a document-shape decision.** `03` produces 10 pages and belongs on the default
thread pool, because a page *run* is created by page re-configuration rather than page count — it
has exactly one. Processes win on documents that repeatedly `#set page(...)`, and on untrusted
templates, and nowhere else.

## One syntax trap you will hit

`$` opens **math mode** in Typst. An unescaped `[$12.00]` swallows everything after it and
reports an "unknown variable" error from somewhere further down the document. Escape it as `\$`.
`03` does, and it got this wrong first.
