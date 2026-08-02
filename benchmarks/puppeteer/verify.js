// Equivalence check: are the two engines actually rendering the same document?
//
//   node verify.js
//
// A throughput comparison between documents of different sizes is worthless, and
// this is the check a skeptical reader will ask for first. It writes one PDF per
// engine per document into `out/` and reports page count and byte size, so the
// files can be opened and compared by eye as well.
//
// Page counts are read from the PDF page tree rather than by counting `/Type
// /Page`, which also matches `/Pages` nodes and overcounts.

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Compiler } from "../../packages/core/dist/index.js";
import { defaultFonts } from "../../packages/fonts/dist/index.js";
import { DOCUMENTS, LOGO_PNG_BASE64 } from "./documents.js";

const OUT = fileURLToPath(new URL("./out/", import.meta.url));
mkdirSync(OUT, { recursive: true });

const LOGO = Buffer.from(LOGO_PNG_BASE64, "base64");

/** Page count from the catalog's page tree: the largest `/Count` that follows a
 *  `/Type /Pages`. Good enough for a sanity check on files we generated. */
function pageCount(pdf) {
  const text = pdf.toString("latin1");
  const counts = [...text.matchAll(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/gu)].map((m) =>
    Number(m[1]),
  );
  const alt = [...text.matchAll(/\/Count\s+(\d+)/gu)].map((m) => Number(m[1]));
  const all = counts.length > 0 ? counts : alt;
  return all.length > 0 ? Math.max(...all) : 0;
}

// Chromium is launched before the compiler is constructed. This started as a
// workaround for launch failures that looked like a live `Compiler` blocking
// Chromium — a theory that did not survive testing; see the README. The order is
// kept because it costs nothing and removes a variable.
const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();

const compiler = new Compiler({ fonts: defaultFonts, files: { "/logo.png": LOGO } });

const rows = [];
for (const name of Object.keys(DOCUMENTS)) {
  const { pdf, pages, warnings } = await compiler
    .document()
    .source(DOCUMENTS[name].typst(1))
    .compile();
  writeFileSync(`${OUT}${name}-emquad.pdf`, pdf);

  await page.setContent(DOCUMENTS[name].html(1), { waitUntil: "load" });
  const chromePdf = Buffer.from(await page.pdf({ format: "A4", printBackground: true }));
  writeFileSync(`${OUT}${name}-puppeteer.pdf`, chromePdf);

  rows.push({
    document: name,
    emquadPages: pages,
    puppeteerPages: pageCount(chromePdf),
    emquadKib: Math.round(pdf.length / 102.4) / 10,
    puppeteerKib: Math.round(chromePdf.length / 102.4) / 10,
    warnings: warnings.length,
  });
}

await browser.close();
await compiler.close();

console.log(
  "| Document | emquad pages | Chromium pages | emquad size | Chromium size | warnings |",
);
console.log("|---|---|---|---|---|---|");
for (const r of rows) {
  console.log(
    `| ${r.document} | ${r.emquadPages} | ${r.puppeteerPages} | ${r.emquadKib} KiB | ` +
      `${r.puppeteerKib} KiB | ${r.warnings} |`,
  );
}
console.log(`\nPDFs written to ${OUT} — open them side by side.`);
