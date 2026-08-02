// The documents under test, defined once per engine so the two stay equivalent.
//
// **Equivalence is the whole ballgame here.** A "hello world" comparison
// flatters Typst unfairly, and a benchmark the audience can dismiss is worth
// less than no benchmark. Both engines render, for each document: the same page
// size and margins, the same table with the same number of rows, the same
// header fill, the same body font, and the same embedded raster logo.
//
// They will not be pixel-identical — two typesetting engines never are. What
// they are is the same *work*: parse a template, lay out a table across pages,
// shape text in an embedded font, decode and place an image, write a PDF.

/** A 2×2 PNG, base64. Small on purpose: this measures image decode and
 *  placement, not image scaling, and a large asset would swamp the difference
 *  between the engines with libpng time they both pay equally. */
export const LOGO_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGOQsop69+4/w7t3" +
  "/6WsogAw6gcTzBiEqQAAAABJRU5ErkJggg==";

/** Deterministic row data, so both engines lay out identical content and a
 *  varying `n` prevents either from serving a whole document from cache. */
export function rows(n, count) {
  return Array.from({ length: count }, (_, i) => ({
    item: `Widget ${n}-${i}`,
    qty: ((i * 7 + n) % 90) + 1,
    price: (((i * 37 + n) % 9000) / 100 + 1).toFixed(2),
  }));
}

const PAGE_CSS = `
  @page { size: A4; margin: 20mm; }
  body { font-family: "Libertinus Serif", serif; color: #1a3a5a; margin: 0; }
  h1 { font-size: 20pt; margin: 0 0 8mm 0; }
  table { border-collapse: collapse; width: 100%; font-size: 10pt; }
  th, td { border: 0.5pt solid #888888; padding: 2mm 3mm; text-align: left; }
  thead th { background: #eeeeff; }
  .logo { width: 20mm; height: 20mm; image-rendering: pixelated; }
`;

export function invoiceHtml(n) {
  const body = rows(n, 8)
    .map((r) => `<tr><td>${r.item}</td><td>${r.qty}</td><td>${r.price}</td></tr>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>${PAGE_CSS}</style></head>
<body>
<img class="logo" src="data:image/png;base64,${LOGO_PNG_BASE64}">
<h1>Invoice ${n}</h1>
<table><thead><tr><th>Item</th><th>Qty</th><th>Price</th></tr></thead>
<tbody>${body}</tbody></table>
</body></html>`;
}

export function invoiceTypst(n) {
  const body = rows(n, 8)
    .map((r) => `  [${r.item}], [${r.qty}], [${r.price}],`)
    .join("\n");
  return `#set page(width: 210mm, height: 297mm, margin: 20mm)
#set text(font: "Libertinus Serif", fill: rgb("#1a3a5a"), size: 10pt)
#image("/logo.png", width: 20mm, height: 20mm)
#text(size: 20pt)[= Invoice ${n}]
#table(
  columns: 3, stroke: 0.5pt + rgb("#888888"),
  fill: (_, y) => if y == 0 { rgb("#eeeeff") },
  table.header([*Item*], [*Qty*], [*Price*]),
${body}
)
`;
}

/** A long table that spans pages, with the header repeating on each. This is
 *  the shape that separates the engines: pagination with a repeating header is
 *  a genuine layout problem rather than a single-page render. */
export function reportHtml(n) {
  const body = rows(n, 120)
    .map((r) => `<tr><td>${r.item}</td><td>${r.qty}</td><td>${r.price}</td></tr>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>${PAGE_CSS}
  thead { display: table-header-group; }
</style></head>
<body>
<img class="logo" src="data:image/png;base64,${LOGO_PNG_BASE64}">
<h1>Report ${n}</h1>
<table><thead><tr><th>Item</th><th>Qty</th><th>Price</th></tr></thead>
<tbody>${body}</tbody></table>
</body></html>`;
}

export function reportTypst(n) {
  const body = rows(n, 120)
    .map((r) => `  [${r.item}], [${r.qty}], [${r.price}],`)
    .join("\n");
  return `#set page(width: 210mm, height: 297mm, margin: 20mm)
#set text(font: "Libertinus Serif", fill: rgb("#1a3a5a"), size: 10pt)
#image("/logo.png", width: 20mm, height: 20mm)
#text(size: 20pt)[= Report ${n}]
#table(
  columns: 3, stroke: 0.5pt + rgb("#888888"),
  fill: (_, y) => if y == 0 { rgb("#eeeeff") },
  table.header([*Item*], [*Qty*], [*Price*]),
${body}
)
`;
}

export const DOCUMENTS = {
  invoice: { html: invoiceHtml, typst: invoiceTypst },
  report: { html: reportHtml, typst: reportTypst },
};
