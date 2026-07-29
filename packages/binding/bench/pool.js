// Throughput against pool size, and what pinning typst's rayon actually costs.
//
//   node bench/pool.js                       # invoice
//   node bench/pool.js multirun              # the shape where it should matter
//   EMQUAD_DOCS=1000 node bench/pool.js
//
// Answers the question Phase 1 could not: hard rule 9 says pinning typst's
// internal rayon to one thread is worth up to 43% under load, but Phase 1
// measured it *costing* 12% single-threaded. The difference is supposed to be
// contention, which only appears once several workers compile at once — which
// is exactly what this pool creates.
//
// # Method
//
// **One configuration per process.** `comemo`'s cache is process-global, and
// disjoint document indices are not disjoint work: two invoices differing only
// in a substituted number share nearly all of their layout, so whichever
// configuration runs second in a shared process harvests the first one's cache.
// That artifact has produced two confidently wrong numbers in this project
// already. `bench/poolcmp.sh` forks a process per configuration.

import { availableParallelism } from "node:os";

import { Compiler } from "../index.js";
import { fonts } from "../test/fixtures.js";

const INVOICE = (n) => `
#set page(width: 210mm, height: 297mm, margin: 20mm)
#set text(fill: rgb("#1a3a5a"))
= Invoice ${n}
#table(
  columns: 3, stroke: 0.5pt + rgb("#888888"),
  fill: (_, y) => if y == 0 { rgb("#eeeeff") },
  table.header([*Item*], [*Qty*], [*Price*]),
  [Widget], [${n}], [$12.00$], [Gadget], [7], [$45.50$],
)
#rect(fill: gradient.linear(rgb("#ff0000"), rgb("#0000ff")), width: 100%, height: 2cm)
`;

// `typst-layout` parallelizes over page *runs*, which are created by page
// re-configuration rather than by page count. An ordinary document has exactly
// one, so this is the only shape that engages typst's rayon at all.
const MULTIRUN = (n) => `
= Multi-run ${n}
#for i in range(40) [
  #set page(width: 210mm, height: 297mm, margin: (x: 20mm + i * 0.1mm, y: 20mm))
  == Run ${n}-#i
  #lorem(60)
]
`;

const documents = { invoice: INVOICE, multirun: MULTIRUN };

const name = process.argv[2] ?? "invoice";
const docs = Number(process.env.EMQUAD_DOCS ?? 400);
const pinRayon = process.env.EMQUAD_PIN !== "0";
const sizes = process.env.EMQUAD_SIZES
  ? process.env.EMQUAD_SIZES.split(",").map(Number)
  : [1, 2, 4, 8, availableParallelism()];

const document = documents[name];
if (!document) {
  throw new Error(`unknown document \`${name}\`; expected invoice or multirun`);
}

const loaded = fonts();

async function measure(poolSize, offset) {
  const compiler = new Compiler({
    fonts: loaded,
    poolSize,
    queueCapacity: docs + 1,
    pinRayon,
  });

  // Each pool size gets its own document range, so a later size cannot harvest
  // an earlier one's memo cache.
  const sources = Array.from({ length: docs }, (_, n) => document(offset + n));

  const started = process.hrtime.bigint();
  await Promise.all(sources.map((source) => compiler.compile({ source })));
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;

  return { perDoc: (seconds / docs) * 1e6, rate: docs / seconds };
}

console.log(
  `document: ${name}, ${docs} compiles per size, typst rayon: ${
    pinRayon ? "pinned to 1 thread" : "unpinned"
  }`,
);
console.log(
  `${"threads".padStart(8)}${"µs/doc".padStart(12)}${"docs/s".padStart(10)}${"speedup".padStart(10)}`,
);

let baseline;
let offset = 1;
for (const size of sizes) {
  const { perDoc, rate } = await measure(size, offset);
  baseline ??= rate;
  offset += docs * 1000;
  console.log(
    `${String(size).padStart(8)}${perDoc.toFixed(1).padStart(12)}${rate.toFixed(0).padStart(10)}${(rate / baseline).toFixed(2).padStart(9)}x`,
  );
}
