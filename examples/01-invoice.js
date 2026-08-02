// A data-driven invoice: JSON in, PDF out.
//
//   node 01-invoice.js
//
// The shape almost every user starts with, and it demonstrates the one rule
// that causes production incidents if you get it wrong — see `.asset` below.

import { writeFileSync } from "node:fs";

import { Compiler } from "@emquad/core";
import { defaultFonts } from "@emquad/fonts";

// A 2×2 PNG standing in for your logo, so the example needs no binary fixture.
const LOGO = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGOQsop69+4/w7t3" +
    "/6WsogAw6gcTzBiEqQAAAABJRU5ErkJggg==",
  "base64",
);

// The template lives in the compiler's base layer, so it is parsed once and
// reused by every compile rather than shipped with each request.
const TEMPLATE = `
#let invoice(data) = {
  set page(width: 210mm, height: 297mm, margin: 20mm)
  set text(font: "Libertinus Serif", size: 10pt, fill: rgb("#1a3a5a"))

  grid(
    columns: (1fr, auto),
    align: (left + horizon, right),
    text(size: 18pt, weight: "bold")[Invoice #data.number],
    image("/logo.png", width: 18mm),
  )
  v(4mm)
  [*Billed to:* #data.customer]
  v(6mm)

  table(
    columns: (1fr, auto, auto),
    align: (left, right, right),
    stroke: 0.5pt + rgb("#cccccc"),
    fill: (_, y) => if y == 0 { rgb("#eeeeff") },
    table.header([*Description*], [*Qty*], [*Amount*]),
    ..data.lines.map(line => (
      [#line.description],
      [#line.qty],
      [#line.amount],
    )).flatten(),
    table.footer([*Total*], [], [*#data.total*]),
  )
}
`;

// Build the compiler **once** and keep it. Fonts are parsed here, the base VFS
// is built here, and the memo cache lives here — constructing one per request
// costs roughly an order of magnitude.
const compiler = new Compiler({
  fonts: defaultFonts,
  files: {
    "/template.typ": TEMPLATE,
    // A canonical path. Per-tenant logos go at this *same* path with different
    // bytes — see below.
    "/logo.png": LOGO,
  },
});

const data = {
  number: "INV-1024",
  customer: "Acme Corporation",
  lines: [
    { description: "Design retainer", qty: 1, amount: "$4,000.00" },
    { description: "Implementation", qty: 12, amount: "$18,000.00" },
    { description: "Hosting (annual)", qty: 1, amount: "$1,200.00" },
  ],
  total: "$23,200.00",
};

const { pdf, pages, warnings } = await compiler
  .document()
  .source('#import "/template.typ": invoice\n#invoice(json("/data.json"))')
  .data(data)
  // **Override by content at a stable path.** `.asset("/logo.png", tenantLogo)`
  // is correct; `.asset(\`/logo-\${tenantId}.png\`, ...)` interns a new path in a
  // process-global table that is never freed and is capped at 65,535 — it leaks
  // permanently and aborts the process at around 65k renders.
  .asset("/logo.png", LOGO)
  .compile({ tagged: false });

// Warnings arrive on *success*, and are the likeliest place a silently-wrong
// document announces itself. Do not drop them.
for (const warning of warnings) console.warn(`warning: ${warning.message}`);

writeFileSync(new URL("./out/01-invoice.pdf", import.meta.url), pdf);
console.log(`wrote out/01-invoice.pdf — ${pages} page, ${(pdf.length / 1024).toFixed(1)} KiB`);

await compiler.close();
