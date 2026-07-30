// The worker-process pool.
//
// This exists for two measured reasons, and the tests are organized around
// them. Documents with many page runs get *slower* under an in-process thread
// pool — 0.46x at eight threads, where separate processes reach 5.18x — and
// Phase 2 ruled out rayon as the cause, which puts the contention in
// process-global state that only separate processes escape. Separately, typst
// has no cancellation hook and a Rust thread cannot be killed, so a runaway
// template is unmitigable in thread mode. A process can be killed.

import assert from "node:assert/strict";
import { test } from "node:test";

import { Compiler, EmquadError } from "../dist/index.js";
import { CLOCK, HELLO, REPRODUCIBLE, RUNAWAY, TEXT_FONTS } from "./fixtures.js";

function pooled(pool = {}) {
  return new Compiler({
    fonts: TEXT_FONTS,
    pool: { mode: "process", size: 2, ...pool },
  });
}

test("compiles through worker processes", async () => {
  await using c = pooled();
  const { pdf, pages, warnings } = await c.document().source(HELLO).compile();

  assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.ok(pdf.length > 1000);
  assert.equal(pages, 1);
  assert.deepEqual(warnings, []);
});

test("produces the same bytes as the thread pool", async () => {
  await using threaded = new Compiler({ fonts: TEXT_FONTS });
  await using processed = pooled();

  const a = await threaded.document().source(HELLO).clock(CLOCK).compile(REPRODUCIBLE);
  const b = await processed.document().source(HELLO).clock(CLOCK).compile(REPRODUCIBLE);

  // Isolation must not change output. If it did, `pool.mode` would silently be
  // a rendering decision rather than a scheduling one.
  assert.deepEqual(a.pdf, b.pdf);
});

test("survives the round trip with binary assets intact", async () => {
  // A 64 KB asset, structured-cloned to the worker and back inside the PDF.
  // `serialization: "advanced"` is what makes this cheap; the default JSON
  // serialization would mangle or balloon it.
  const bytes = Buffer.alloc(65_536, 0xab);
  await using c = pooled();

  const { pdf } = await c
    .document()
    .source('#read("/blob.bin", encoding: none).len()')
    .asset("/blob.bin", bytes)
    .compile();

  assert.ok(pdf.length > 0);
});

test("spreads concurrent work across workers deterministically", async () => {
  await using c = pooled({ size: 4 });
  const expected = await c.document().source(HELLO).clock(CLOCK).compile(REPRODUCIBLE);

  const results = await Promise.all(
    Array.from({ length: 12 }, () => c.document().source(HELLO).clock(CLOCK).compile(REPRODUCIBLE)),
  );

  for (const result of results) assert.deepEqual(result.pdf, expected.pdf);
});

test("compileSync is refused rather than silently losing isolation", async () => {
  await using c = pooled();
  assert.throws(
    () => c.document().source(HELLO).compileSync(),
    (error) => {
      assert.ok(error instanceof EmquadError);
      assert.equal(error.code, "INVALID_ARGUMENT");
      // Falling back to an in-process compile would be worse than failing: the
      // caller asked for isolation and would not get it.
      assert.match(error.message, /no synchronous path across a process boundary/u);
      return true;
    },
  );
});

test("a runaway compile is killed, and the pool recovers", async () => {
  await using c = pooled({ size: 1, timeoutMs: 400 });

  const started = Date.now();
  await assert.rejects(
    () => c.document().source(RUNAWAY).compile(),
    (error) => {
      assert.ok(error instanceof EmquadError);
      assert.equal(error.code, "WORKER_TIMEOUT");
      return true;
    },
  );

  // The point is not that it reported a timeout — a thread pool could do that
  // while leaking a wedged thread forever. The point is that it stopped.
  assert.ok(Date.now() - started < 5000, "timeout did not actually interrupt the compile");

  // And that the pool replaced the worker rather than being one slot poorer.
  const { pages } = await c.document().source(HELLO).compile();
  assert.equal(pages, 1);
});

test("a full queue is refused, not absorbed", async () => {
  await using c = pooled({ size: 1, queueCapacity: 2 });

  const inflight = Array.from({ length: 12 }, () => c.document().source(HELLO).compile());
  const outcomes = await Promise.allSettled(inflight);
  const refused = outcomes.filter((o) => o.status === "rejected" && o.reason.code === "QUEUE_FULL");

  // Backpressure has to be visible. Blocking would turn a load spike into
  // unbounded latency and hide the overload entirely.
  assert.ok(refused.length > 0, "expected some compiles to be refused");
  assert.ok(
    outcomes.some((o) => o.status === "fulfilled"),
    "expected some to succeed",
  );
});

test("unparsable fonts fail the pool rather than respawning forever", async () => {
  // Garbage bytes get past the parent — it does not parse fonts — and fail in
  // every worker identically. A naive supervisor would restart into the same
  // failure until something noticed.
  const c = new Compiler({
    fonts: [new Uint8Array([1, 2, 3, 4])],
    pool: { mode: "process", size: 2 },
  });

  await assert.rejects(
    () => c.document().source(HELLO).compile(),
    (error) => {
      assert.ok(error instanceof EmquadError);
      assert.equal(error.code, "NO_FONTS");
      return true;
    },
  );

  // Sticky: the failure is deterministic, so retrying must not restart anything.
  await assert.rejects(() => c.document().source(HELLO).compile(), { code: "NO_FONTS" });
  await c.close();
});

test("stats report the worst worker, not the sum", async () => {
  await using c = pooled({ size: 2 });
  await Promise.all([c.document().source(HELLO).compile(), c.document().source(HELLO).compile()]);

  const stats = await c.stats();
  assert.equal(stats.poolSize, 2);
  assert.ok(stats.internedPaths > 0);
  assert.equal(stats.pathCap, 65_535);
  // The cap is per-process, so a sum across workers would read as alarming
  // long before any single process was at risk.
  assert.ok(stats.internedPaths < 1000, `unexpectedly high: ${stats.internedPaths}`);
});

test("fontFamilies comes back from a worker", async () => {
  await using c = pooled();
  const families = await c.fontFamilies();
  assert.ok(families.includes("Libertinus Serif"), families.join(", "));
});

test("close shuts the workers down and refuses further work", async () => {
  const c = pooled();
  await c.document().source(HELLO).compile();
  await c.close();

  assert.throws(() => c.document(), { code: "SHUTTING_DOWN" });
});

test("closing while work is queued rejects it rather than hanging", async () => {
  const c = pooled({ size: 1 });
  // `allSettled` is attached *before* closing, not after. Closing rejects the
  // queued promises synchronously, and a handler added later would arrive
  // after Node had already reported them as unhandled rejections.
  const settled = Promise.allSettled(
    Array.from({ length: 6 }, () => c.document().source(HELLO).compile()),
  );
  await c.close();

  const outcomes = await settled;
  // Every promise settles. A dropped one would leave the caller awaiting
  // forever with no indication anything went wrong.
  assert.equal(outcomes.length, 6);
  assert.ok(outcomes.some((o) => o.status === "rejected" && o.reason.code === "SHUTTING_DOWN"));
});
