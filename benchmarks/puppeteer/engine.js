// One engine, one process. Prints a JSON result line on stdout.
//
//   node engine.js <emquad|puppeteer> <document> <docs> <concurrency>
//
// **Each engine gets its own process, and that is not tidiness.** Sharing one
// means each engine's peak RSS includes the other's — and RSS is the measurement
// where these two differ most, by more than tenfold. It also means whichever
// runs second inherits the heap the first left behind.
//
// This mirrors the rule the Rust benchmarks already follow: one configuration
// per process.

import { execFileSync } from "node:child_process";

import { Compiler } from "../../packages/core/dist/index.js";
import { defaultFonts } from "../../packages/fonts/dist/index.js";
import { DOCUMENTS, LOGO_PNG_BASE64 } from "./documents.js";

const [engine, doc, docsArg, concurrencyArg] = process.argv.slice(2);
const DOCS = Number(docsArg);
const CONCURRENCY = Number(concurrencyArg);
const LOGO = Buffer.from(LOGO_PNG_BASE64, "base64");

/** RSS of this process and every descendant, in MiB.
 *
 *  Chromium's memory lives in child processes that `process.memoryUsage()`
 *  cannot see, so reading it from Node would understate Puppeteer by an order
 *  of magnitude. emquad is measured the same way for symmetry — its worker
 *  processes are real children too, in `mode: "process"`. */
function treeRssMib() {
  try {
    const out = execFileSync("ps", ["-Ao", "rss=,ppid=,pid="], { encoding: "utf8" });
    const rows = out
      .trim()
      .split("\n")
      .map((line) => {
        const [rss, ppid, pid] = line.trim().split(/\s+/u);
        return [Number(rss), Number(ppid), Number(pid)];
      })
      .filter((r) => r.every((v) => Number.isFinite(v)));
    const byParent = new Map();
    for (const [rss, ppid, pid] of rows) {
      if (!byParent.has(ppid)) byParent.set(ppid, []);
      byParent.get(ppid).push({ rss, pid });
    }
    const seen = new Set();
    let total = 0;
    const walk = (pid) => {
      if (seen.has(pid)) return;
      seen.add(pid);
      for (const child of byParent.get(pid) ?? []) {
        total += child.rss;
        walk(child.pid);
      }
    };
    const self = rows.find((r) => r[2] === process.pid);
    total += self ? self[0] : 0;
    walk(process.pid);
    return total / 1024;
  } catch {
    return 0;
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

/** Run `total` tasks with at most `limit` in flight, recording each latency.
 *
 *  RSS is sampled on a timer *during* the run. Sampling afterwards misses the
 *  peak, and for Puppeteer reading it after `browser.close()` measures a machine
 *  with no browser on it — which is how an earlier version of this harness
 *  reported Chromium and emquad using identical memory. */
async function saturate(total, limit, task) {
  const latencies = [];
  let next = 0;
  let peakRss = treeRssMib();
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, treeRssMib());
  }, 250);
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= total) return;
      const started = performance.now();
      await task(i);
      latencies.push(performance.now() - started);
    }
  };
  const started = performance.now();
  try {
    await Promise.all(Array.from({ length: limit }, worker));
  } finally {
    clearInterval(sampler);
  }
  return { latencies, wall: performance.now() - started, peakRss };
}

function summarize(name, { latencies, wall, peakRss }, cold, restRss, extra = {}) {
  const sorted = latencies.toSorted((a, b) => a - b);
  return {
    engine: name,
    coldStartMs: cold,
    docsPerSec: (latencies.length / wall) * 1000,
    meanMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    p50Ms: percentile(sorted, 50),
    p99Ms: percentile(sorted, 99),
    rssAtRestMib: restRss,
    rssUnderLoadMib: peakRss,
    ...extra,
  };
}

async function runEmquad() {
  // Cold start: constructing the compiler — parsing 17 font files, building the
  // base VFS, starting the pool — plus the first compile. The honest analogue of
  // launching a browser and rendering the first page.
  const coldStarted = performance.now();
  const compiler = new Compiler({
    fonts: defaultFonts,
    files: { "/logo.png": LOGO },
    pool: { size: CONCURRENCY },
  });
  await compiler.document().source(DOCUMENTS[doc].typst(0)).compile();
  const cold = performance.now() - coldStarted;

  const restRss = treeRssMib();
  const result = await saturate(DOCS, CONCURRENCY, async (i) => {
    await compiler
      .document()
      .source(DOCUMENTS[doc].typst(i + 1))
      .compile();
  });
  const summary = summarize("emquad", result, cold, restRss);
  await compiler.close();
  return summary;
}

async function runPuppeteer() {
  const { default: puppeteer } = await import("puppeteer");

  // `PUPPETEER_EXECUTABLE_PATH` overrides the bundled build, for when the pinned
  // Chromium will not download. The version actually used is reported, so a
  // mismatch is visible rather than silent.
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

  const coldStarted = performance.now();
  const browser = await puppeteer.launch({
    executablePath,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const first = await browser.newPage();
  await first.setContent(DOCUMENTS[doc].html(0), { waitUntil: "load" });
  await first.pdf({ format: "A4", printBackground: true });
  const cold = performance.now() - coldStarted;

  // A page pool matching emquad's worker pool. `first` is reused rather than
  // discarded, for the same reason a real service would reuse it.
  const pages = [first];
  while (pages.length < CONCURRENCY) pages.push(await browser.newPage());
  const free = [...pages];

  const restRss = treeRssMib();
  const result = await saturate(DOCS, CONCURRENCY, async (i) => {
    const page = free.pop();
    try {
      await page.setContent(DOCUMENTS[doc].html(i + 1), { waitUntil: "load" });
      await page.pdf({ format: "A4", printBackground: true });
    } finally {
      free.push(page);
    }
  });

  const version = await browser.version();
  const summary = summarize("puppeteer", result, cold, restRss, { browser: version });
  await browser.close();
  return summary;
}

const summary = engine === "emquad" ? await runEmquad() : await runPuppeteer();
console.log(JSON.stringify(summary));
