// emquad against Puppeteer, on equivalent documents.
//
//   node run.js [invoice|report] [docs] [concurrency]
//
// Reports, per engine: cold start, steady-state throughput, p50/p99 latency,
// and RSS at rest and under load. Each engine runs in its own process — see
// `engine.js` for why that is a correctness requirement rather than a style
// choice.
//
// # What this harness is careful about
//
// **Chromium's launch is amortized, not excluded and not charged per PDF.** A
// real service launches the browser once at startup and reuses it, so billing
// every PDF for a full launch would be dishonest in our favour. It is reported
// separately as cold start, which is where it genuinely hurts: short-lived,
// Lambda-style invocations.
//
// **Pages are reused, not created per document.** `browser.newPage()` costs
// real milliseconds, and a tuned Puppeteer service pools pages exactly as it
// pools browsers. Creating one per PDF would measure a naive implementation
// rather than a good one.
//
// **Both engines get the same concurrency**, from the same argument.
//
// **Documents vary by `n`**, or this would measure a cache in both engines
// rather than the engines.
//
// # What it deliberately does not claim
//
// The PDFs are not identical — two typesetting engines never are; see
// `documents.js` for what is held equal. And **Typst is not a Chromium
// replacement**: it does not render HTML, so migrating means rewriting
// templates. That cost is real, it is often the deciding factor, and this
// benchmark does not measure it.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DOCUMENTS } from "./documents.js";

const DOC = process.argv[2] ?? "invoice";
const DOCS = Number(process.argv[3] ?? 100);
const CONCURRENCY = Number(process.argv[4] ?? 4);

if (!DOCUMENTS[DOC]) {
  console.error(`unknown document "${DOC}" — expected one of ${Object.keys(DOCUMENTS).join(", ")}`);
  process.exit(1);
}

const ENGINE = fileURLToPath(new URL("./engine.js", import.meta.url));

function measure(engine) {
  const out = execFileSync(
    process.execPath,
    [ENGINE, engine, DOC, String(DOCS), String(CONCURRENCY)],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  // The engine prints one JSON line last; anything before it is noise from the
  // runtime (Chromium is chatty on stderr, but warnings reach stdout too).
  const line = out.trim().split("\n").at(-1);
  return JSON.parse(line);
}

console.log(
  `document=${DOC} docs=${DOCS} concurrency=${CONCURRENCY} node=${process.version} ` +
    `platform=${process.platform}/${process.arch}`,
);

const results = [measure("emquad"), measure("puppeteer")];
const [emquad, puppeteer] = results;
const fmt = (n, d = 1) => n.toFixed(d);

console.log("");
console.log(
  "| Engine | Cold start | Throughput | Mean | p50 | p99 | RSS at rest | RSS under load |",
);
console.log("|---|---|---|---|---|---|---|---|");
for (const r of results) {
  console.log(
    `| ${r.engine} | ${fmt(r.coldStartMs)} ms | ${fmt(r.docsPerSec)} docs/s | ` +
      `${fmt(r.meanMs)} ms | ${fmt(r.p50Ms)} ms | ${fmt(r.p99Ms)} ms | ` +
      `${fmt(r.rssAtRestMib, 0)} MiB | ${fmt(r.rssUnderLoadMib, 0)} MiB |`,
  );
}

const speedup = emquad.docsPerSec / puppeteer.docsPerSec;
console.log("");
console.log(`emquad is ${fmt(speedup, 1)}× Puppeteer's throughput on this document.`);
if (puppeteer.browser) console.log(`Chromium: ${puppeteer.browser}`);

const out = fileURLToPath(new URL(`./results-${DOC}-c${CONCURRENCY}.json`, import.meta.url));
writeFileSync(
  out,
  JSON.stringify(
    {
      document: DOC,
      docs: DOCS,
      concurrency: CONCURRENCY,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      results,
      speedup,
    },
    null,
    2,
  ) + "\n",
);
console.log(`wrote ${out}`);
