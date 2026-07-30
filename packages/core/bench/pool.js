// Thread pool against worker-process pool.
//
//   node bench/pool.js <invoice|multirun> <thread|process> <size> [docs]
//
// **One configuration per process, always.** `comemo`'s cache is
// process-global, so a second configuration in the same process harvests memo
// hits from the first. Hard rule 10 exists because that produced a completely
// wrong result in Phase 0 before anyone noticed. Use `poolcmp.sh` to compare.
//
// Documents are distinct per index, and each configuration is given its own
// index range for the same reason.

import { availableParallelism } from "node:os";

import { fontsFor } from "@emquad/fonts";

import { Compiler } from "../dist/index.js";

// An invoice: color, a table with a per-row fill callback, a gradient. One page
// and, importantly, one page *run* — the target workload.
const INVOICE = (n) => `
#set page(width: 210mm, height: 297mm, margin: 20mm)
#set text(fill: rgb("#1a3a5a"))
= Invoice ${n}
#table(
  columns: 3, stroke: 0.5pt + rgb("#888888"),
  fill: (_, y) => if y == 0 { rgb("#eeeeff") },
  table.header([*Item*], [*Qty*], [*Price*]),
  [Widget], [${n}], [\\$12.00], [Gadget], [7], [\\$45.50],
)
#rect(fill: gradient.linear(rgb("#ff0000"), rgb("#0000ff")), width: 100%, height: 2cm)
`;

// Forty page *runs*. Typst parallelizes layout over runs, which come from page
// re-configuration rather than from page count — an ordinary document has
// exactly one. This is the shape whose throughput collapsed under threads in
// Phase 0, and the reason the process pool exists.
const MULTIRUN = (n) => `
= Multi-run ${n}
#for i in range(40) [
  #set page(width: 210mm, height: 297mm, margin: (x: 20mm + i * 0.1mm, y: 20mm))
  == Run ${n}-#i
  #lorem(60)
]
`;

const DOCS = { invoice: INVOICE, multirun: MULTIRUN };

const [, , docName = "invoice", mode = "thread", sizeArg, countArg, offsetArg] = process.argv;
const document = DOCS[docName];
if (!document) throw new Error(`unknown document ${docName}`);

const size = Number(sizeArg ?? availableParallelism());
const count = Number(countArg ?? (docName === "multirun" ? 200 : 2000));
const offset = Number(offsetArg ?? 0);

const startedConstruct = performance.now();
const compiler = new Compiler({
  fonts: fontsFor("libertinus-serif"),
  pool: { mode, size },
});

// A first compile, discarded. It covers the cold path — the worker handshake in
// process mode, the one-time 6.6 ms first compile in both — which would
// otherwise be charged to the measured run and read as a throughput
// difference.
await compiler.document().source(document(offset)).compile({ tagged: false });
const startupMs = performance.now() - startedConstruct;

/** Compile one document and report its size, so the output cannot be optimized away. */
const one = async (index) => {
  const result = await compiler
    .document()
    .source(document(offset + 1 + index))
    .compile({ tagged: false });
  return result.pdf.length;
};

const started = performance.now();
let bytes = 0;
let pending = [];
for (let i = 0; i < count; i += 1) {
  pending.push(one(i));
  // Keep the queue bounded well under `queueCapacity`; the point is to measure
  // steady-state throughput, not backpressure.
  if (pending.length >= size * 4) {
    for (const size_ of await Promise.all(pending)) bytes += size_;
    pending = [];
  }
}
for (const size_ of await Promise.all(pending)) bytes += size_;
const elapsed = performance.now() - started;

await compiler.close();

const perDoc = (elapsed * 1000) / count;
console.log(
  JSON.stringify({
    doc: docName,
    mode,
    size,
    docs: count,
    startupMs: Number(startupMs.toFixed(1)),
    usPerDoc: Number(perDoc.toFixed(0)),
    docsPerSec: Number((count / (elapsed / 1000)).toFixed(0)),
    bytes,
  }),
);
