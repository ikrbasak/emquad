// Startup cost of getting fonts into worker processes.
//
//   node bench/fonts.js <descriptor|bytes> <size>
//
// The handoff flagged this as the expensive part of the process pool: every
// worker parses its own fonts, and the default set is 9.3 MB. Passing a `{ file }`
// descriptor sends a path and lets the worker open it; passing a Uint8Array
// structured-clones the bytes to every worker.
import { readFileSync } from "node:fs";
import { defaultFonts } from "@emquad/fonts";
import { Compiler } from "../dist/index.js";

const [, , form = "descriptor", sizeArg = "8"] = process.argv;
const size = Number(sizeArg);
const fonts = form === "bytes" ? defaultFonts.map((f) => readFileSync(f.file)) : defaultFonts;
const payload = fonts.reduce((n, f) => n + (f.file ? 0 : f.length), 0);

const t = performance.now();
const c = new Compiler({ fonts, pool: { mode: "process", size } });
await c.document().source("= Hello").compile();
const ready = performance.now() - t;
await c.close();

console.log(
  JSON.stringify({
    form,
    size,
    startupMs: Number(ready.toFixed(1)),
    ipcBytes: payload * size,
  }),
);
