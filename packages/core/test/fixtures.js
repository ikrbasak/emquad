// Shared fixtures for the `@emquad/core` tests.

import { defaultFonts, fontsFor } from "@emquad/fonts";

/** The full 17-face default set. */
export const FONTS = defaultFonts;

/**
 * Text faces only — no math.
 *
 * Six faces instead of seventeen, which is ~4 MB less to parse per compiler.
 * Every test here builds at least one compiler and the process-pool tests build
 * several, so this is the difference between a suite that runs in a second and
 * one that does not.
 */
export const TEXT_FONTS = fontsFor("libertinus-serif");

export const HELLO = "= Hello\nA paragraph of text.";

/** A document with an error at a known position: line 2, column 6. */
export const BROKEN = "= Title\n#(1 + )\n";

/** Emits a warning without failing: an unmatched font family. */
export const WARNS = '#set text(font: "No Such Font Family")\nHello';

export const INVOICE = `
#set page(width: 210mm, height: 297mm, margin: 20mm)
#let data = json("/data.json")
= Invoice #data.number
#table(
  columns: 2,
  table.header([*Item*], [*Price*]),
  ..data.lines.map(line => ([#line.name], [#line.price])).flatten(),
)
Total: #data.total
`;

/**
 * A document that takes far longer than any test should wait: ~10 seconds of
 * arithmetic, one page, negligible memory.
 *
 * Used to prove the process pool actually kills a runaway compile. It has to be
 * genuinely slow rather than sleeping, because the point is that typst offers
 * no cancellation hook — a compile in progress never returns to the event loop
 * and cannot be interrupted from JavaScript.
 *
 * It also has to be slow through *computation* rather than output size. A
 * 40,000-page document was the first attempt and was wrong twice over: it
 * completes in 682 ms, and it exhausts the worker's memory on the way back,
 * so the test passed for the wrong reason — reporting a dead worker rather
 * than a killed one.
 */
export const RUNAWAY = `
#let burn(n) = { let s = 0; for i in range(0, n) { s = s + i }; s }
#burn(50000000)
`;

/** A fixed clock, so PDFs are byte-reproducible. */
export const CLOCK = { fixed: 1_785_888_000, offsetMinutes: 0 };

/** PDF options that make two compiles of the same document byte-identical. */
export const REPRODUCIBLE = {
  ident: "test",
  timestamp: 1_785_888_000,
  creator: false,
};
