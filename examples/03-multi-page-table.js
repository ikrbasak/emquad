// A long table that spans pages, with the header repeating on every one.
//
//   node 03-multi-page-table.js
//
// Also the example that shows **how to pick a pool**, because this document is
// exactly the case people get wrong.
//
// A 40-page report like this one has a single page *run* — a run is created by
// page re-configuration, not by page count — so it belongs on the default
// thread pool. `pool.mode: "process"` would make it *slower*. Processes win on
// documents that repeatedly `#set page(...)`, and on untrusted templates, and
// nothing else.

import { writeFileSync } from "node:fs";

import { Compiler } from "@emquad/core";
import { defaultFonts } from "@emquad/fonts";

const ROWS = 400;

const transactions = Array.from({ length: ROWS }, (_, i) => ({
  id: `TX-${String(i + 1).padStart(5, "0")}`,
  date: `2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
  account: ["Operations", "Marketing", "Engineering", "Facilities"][i % 4],
  amount: (((i * 137) % 9000) / 100 + 12).toFixed(2),
}));

const compiler = new Compiler({ fonts: defaultFonts, pool: { size: 4 } });

// `$` opens **math mode** in typst, so an unescaped `[$12.00]` swallows
// everything after it and reports a baffling "unknown variable" from further
// down the table. Escape it as `\$`.
const rows = transactions
  .map((t) => `  [${t.id}], [${t.date}], [${t.account}], [\\$${t.amount}],`)
  .join("\n");

const { pdf, pages, warnings } = await compiler
  .document()
  .source(`
// A single \`set page\` for the whole document: one page run, however many
// pages it turns into. That is why this belongs on the thread pool.
#set page(
  width: 210mm, height: 297mm, margin: (x: 18mm, y: 20mm),
  header: text(size: 8pt, fill: rgb("#888888"))[Transaction register — 2026],
  footer: context text(size: 8pt, fill: rgb("#888888"))[
    #h(1fr) #counter(page).display("1 of 1", both: true)
  ],
)
#set text(font: "Libertinus Serif", size: 9pt, fill: rgb("#1a3a5a"))

#text(size: 16pt, weight: "bold")[Transaction register]
#v(4mm)

#table(
  columns: (auto, auto, 1fr, auto),
  align: (left, left, left, right),
  stroke: 0.5pt + rgb("#dddddd"),
  fill: (_, y) => if y == 0 { rgb("#eeeeff") },
  // \`table.header\` repeats on every page the table spans. Without it the
  // columns are unlabelled from page two onward.
  table.header([*ID*], [*Date*], [*Account*], [*Amount*]),
${rows}
)
`)
  .compile({ tagged: false });

for (const warning of warnings) console.warn(`warning: ${warning.message}`);

writeFileSync(new URL("./out/03-multi-page-table.pdf", import.meta.url), pdf);
console.log(
  `wrote out/03-multi-page-table.pdf — ${ROWS} rows over ${pages} pages, ` +
    `${(pdf.length / 1024).toFixed(1)} KiB`,
);

const stats = await compiler.stats();
console.log(
  `interned paths: ${stats.internedPaths} of ${stats.pathCap} — ` +
    `flat no matter how many documents you compile, because the paths are canonical`,
);

await compiler.close();
