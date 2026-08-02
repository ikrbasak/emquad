// A report with a chart, via pre-rendered SVG.
//
//   node 02-report-with-chart.js
//
// This is **Route B**, and the recommended default for report and invoice work:
// render the chart in Node with whatever charting library you already use, put
// the SVG in the VFS, and `image()` it. No registry dependency, no new markup
// language for your team to learn.
//
// (Route A is the `@preview` packages — `cetz`, `cetz-plot`, `lilaq` — through
// `@emquad/resolver`. Better for dense scientific plotting, more to learn.)
//
// # The trap this example exists to demonstrate
//
// **SVG text in a font family you have not registered fails silently.** Typst
// emits no diagnostic at all — not an error, not a warning. With a serif family
// registered the text is substituted; with only a monospace family registered it
// renders as *nothing*, and you get a valid PDF with a chart missing all its
// labels.
//
// Ordinary `#set text(font: ...)` warns. SVG is not on that code path, so no
// check can catch this. The SVG below names a family that is actually
// registered, which is the only real defense.

import { writeFileSync } from "node:fs";

import { Compiler } from "@emquad/core";
import { defaultFonts } from "@emquad/fonts";

/** A bar chart as SVG. Stands in for Chart.js, D3, Vega, or whatever you use —
 *  the point is that emquad only ever sees the finished SVG. */
function barChartSvg(series, { width = 520, height = 220, pad = 34 } = {}) {
  const max = Math.max(...series.map((d) => d.value));
  const plotWidth = width - pad * 2;
  const plotHeight = height - pad * 2;
  const slot = plotWidth / series.length;

  const bars = series
    .map((d, i) => {
      const h = (d.value / max) * plotHeight;
      const x = pad + i * slot + slot * 0.15;
      const y = height - pad - h;
      const w = slot * 0.7;
      return (
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" ` +
        `height="${h.toFixed(1)}" fill="#4a6fa5" />` +
        `<text x="${(x + w / 2).toFixed(1)}" y="${(height - pad + 14).toFixed(1)}" ` +
        `text-anchor="middle" font-family="Libertinus Serif" font-size="11">${d.label}</text>` +
        `<text x="${(x + w / 2).toFixed(1)}" y="${(y - 5).toFixed(1)}" ` +
        `text-anchor="middle" font-family="Libertinus Serif" font-size="10" ` +
        `fill="#1a3a5a">${d.value}</text>`
      );
    })
    .join("");

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">` +
    `<line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" ` +
    `stroke="#888888" stroke-width="1" />` +
    bars +
    `</svg>`
  );
}

const revenue = [
  { label: "Q1", value: 42 },
  { label: "Q2", value: 58 },
  { label: "Q3", value: 51 },
  { label: "Q4", value: 73 },
];

// `defaultFonts` includes Libertinus Serif, which is the family the SVG above
// names. If you ship a trimmed font set, **keep a serif family** or the chart
// labels disappear without a word.
const compiler = new Compiler({ fonts: defaultFonts });

const { pdf, pages, warnings } = await compiler
  .document()
  .source(`
#set page(width: 210mm, height: 297mm, margin: 20mm)
#set text(font: "Libertinus Serif", size: 11pt, fill: rgb("#1a3a5a"))

#text(size: 18pt, weight: "bold")[Quarterly revenue]
#v(2mm)
Revenue by quarter, in thousands. The chart is an SVG rendered in Node and
placed into the virtual filesystem — typst never sees the chart library.
#v(6mm)

#image("/chart.svg", width: 100%)
#v(6mm)

#table(
  columns: (1fr, auto),
  align: (left, right),
  stroke: 0.5pt + rgb("#cccccc"),
  fill: (_, y) => if y == 0 { rgb("#eeeeff") },
  table.header([*Quarter*], [*Revenue*]),
  ${revenue.map((d) => `[${d.label}], [${d.value}k],`).join("\n  ")}
)
`)
  .asset("/chart.svg", barChartSvg(revenue))
  .compile({ tagged: false });

for (const warning of warnings) console.warn(`warning: ${warning.message}`);

writeFileSync(new URL("./out/02-report-with-chart.pdf", import.meta.url), pdf);
console.log(
  `wrote out/02-report-with-chart.pdf — ${pages} page, ${(pdf.length / 1024).toFixed(1)} KiB`,
);
console.log("open it and check the bar labels are present — that is the rule-12 check");

await compiler.close();
