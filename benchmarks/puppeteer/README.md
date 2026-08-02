# emquad against Puppeteer

The comparison that actually drives the adoption decision, published so it can be reproduced or
disputed.

```sh
cd benchmarks/puppeteer
npm install                      # Chromium download, ~340 MB
node verify.js                   # prove the two documents are equivalent first
node run.js invoice 200 4        # document, documents, concurrency
node run.js report 100 4
```

**Deliberately outside the pnpm workspace.** Puppeteer must never become a dependency of
anything published; it is installed here with plain `npm` and its own lockfile, and
`benchmarks/` is not matched by `pnpm-workspace.yaml`'s `packages/*`.

If the pinned Chromium will not download, point at any local build:

```sh
PUPPETEER_EXECUTABLE_PATH="/path/to/chrome" node run.js invoice 200 4
```

The version actually used is printed with the results, so a mismatch is visible rather than
silent.

## Results

See [`../../.claude/phase-5/01-puppeteer.md`](../../.claude/phase-5/01-puppeteer.md) for the
measured numbers and what they do and do not support. The short version: **the advantage is
between 2× and 33×, and which end you land on depends entirely on the document.** Quoting the
top of that range without the shape of the document attached would be marketing.

## What is held equal

Both engines render, per document: the same page size and margins, the same table with the same
number of rows, the same header fill, the same serif body font, and the same embedded raster
logo. `documents.js` defines each document twice — once as HTML/CSS, once as Typst markup — and
that file is where to look first if you think the comparison is unfair.

`verify.js` writes one PDF per engine per document into `out/` and reports page counts, so the
claim of equivalence is checkable rather than asserted.

They are not pixel-identical, and cannot be: two typesetting engines break lines differently.
On the report, Chromium fits fewer rows per page and produces **5 pages to emquad's 4**, so it
is doing about 25% more page-level work. The findings document normalizes for that.

## What the harness is careful about

- **Chromium's launch is amortized, not excluded and not charged per PDF.** A real service
  launches once at startup. Billing every PDF for a launch would be dishonest in our favour, so
  it is reported separately as cold start — where it genuinely hurts, in short-lived
  Lambda-style invocations.
- **Pages are pooled, not created per document.** A tuned Puppeteer service pools pages exactly
  as it pools browsers. Creating one per PDF would measure a naive implementation.
- **Each engine runs in its own process.** Not tidiness — see below.
- **Documents vary by `n`**, or this measures a cache in both engines rather than the engines.
- **RSS is sampled on a timer during the run**, across the whole process tree. Chromium's memory
  lives in child processes `process.memoryUsage()` cannot see.

## What this harness got wrong first

**Reading RSS after `browser.close()`** measures a machine with no browser on it. The first
version did this and reported Chromium and emquad using *identical* memory — 104 against
105 MiB. The real figures differ by more than tenfold. It is now sampled on a timer during the
run.

**A false alarm worth knowing about:** `puppeteer.launch()` failed repeatedly during development
whenever emquad had run first in the same process, which looked exactly like a live `Compiler`
blocking Chromium. It does not reproduce under test — not with the full font set, not after 400
compiles, not at any pool size — and file descriptors, threads, and RSS are all flat. Those
failures were machine load. If you see one, check what else is running before concluding
anything.

`verify.js` still launches Chromium before constructing the `Compiler`, which costs nothing and
removes one variable.

**Chromium's launch is genuinely flaky on a loaded machine** — null exit code, empty stderr. If
you get one, re-run, and do not benchmark on a machine that is doing anything else. That is good
practice here regardless: every number this harness produces is sensitive to load.

## What this does not claim

It does not claim Typst can replace Chromium. **Typst does not render HTML**, so migrating means
rewriting every template in Typst markup. For a nontrivial invoice that is a day of work, not an
afternoon. A benchmark that ignores that cost is marketing rather than engineering, and the
audience for this package will notice.
