// Node integration tests for the napi boundary.
//
// These cover what `cargo test` cannot: that values survive the FFI crossing
// intact, that a panic surfaces as a value rather than killing the process, and
// that the pool behaves under saturation.
//
// Run: `pnpm --filter @emquad/binding test` (builds with `test-hooks` first).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Compiler, evictCache, setPathLimit, typstVersion } from "../index.js";
import { INVOICE, PNG, fonts } from "./fixtures.js";

const compiler = (options = {}) => new Compiler({ fonts: fonts(), ...options });

describe("construction", () => {
  it("reports the typst version it was built against", () => {
    // Typst is pre-1.0 and rendering changes across minor releases, so users
    // correlating output differences need this at runtime.
    assert.match(typstVersion(), /^\d+\.\d+\.\d+$/u);
  });

  it("refuses an empty font set", () => {
    // Typst would compile this successfully and emit a valid PDF with every
    // text run silently dropped and no diagnostics at all.
    assert.throws(() => new Compiler({ fonts: [] }), /NO_FONTS/u);
  });

  it("exposes the families it registered", () => {
    const families = compiler().fontFamilies;
    assert.ok(families.includes("New Computer Modern"), families.join(", "));
    assert.deepEqual(families, families.toSorted());
  });

  it("reports pool and interner counters", () => {
    const stats = compiler({ poolSize: 3, queueCapacity: 7 }).stats;
    assert.equal(stats.poolSize, 3);
    assert.equal(stats.queueCapacity, 7);
    assert.equal(stats.pathCap, 65535);
    assert.ok(stats.internedPaths >= stats.trackedPaths);
  });
});

describe("compiling", () => {
  it("produces a PDF synchronously", () => {
    const result = compiler().compileSync({ source: INVOICE });

    assert.equal(result.ok, true);
    assert.equal(result.pages, 1);
    assert.equal(result.pdf.subarray(0, 5).toString(), "%PDF-");
    assert.ok(result.pdf.includes("%%EOF"), "truncated PDF");
    // A PDF with no font resource is the blank-page failure mode.
    assert.ok(result.pdf.includes("/Font"), "no font embedded");
  });

  it("produces a PDF asynchronously", async () => {
    const result = await compiler().compile({ source: INVOICE });
    assert.equal(result.ok, true);
    assert.equal(result.pages, 1);
  });

  it("gives identical output through both paths", async () => {
    const c = compiler();
    const request = { source: INVOICE, pdf: { ident: "both", timestamp: false } };
    const sync = c.compileSync(request);
    const viaPool = await c.compile(request);
    assert.deepEqual(sync.pdf, viaPool.pdf);
  });

  it("accepts strings, Buffers, and Uint8Arrays in the VFS", () => {
    const result = compiler({
      files: { "/templates/lib.typ": "#let mark = [ok]" },
    }).compileSync({
      files: {
        "/assets/logo.png": PNG,
        "/assets/mark.svg": new Uint8Array(
          Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>'),
        ),
      },
      source: `#import "/templates/lib.typ": mark
#mark
#image("/assets/logo.png", width: 8pt)
#image("/assets/mark.svg", width: 8pt)`,
    });

    assert.equal(result.ok, true, JSON.stringify(result.error));
  });

  it("lets a per-request file shadow the base layer", () => {
    const c = compiler({ files: { "/config.typ": '#let title = "base"' } });
    const source = '#import "/config.typ": title\n#title';

    const shadowed = c.compileSync({
      source,
      files: { "/config.typ": '#let title = "overlay"' },
    });
    const plain = c.compileSync({ source });

    assert.equal(shadowed.ok, true);
    assert.notDeepEqual(shadowed.pdf, plain.pdf);
  });

  it("imports a mounted package", () => {
    const result = compiler({
      packages: [
        // The manifest is required — typst reads it to find the entrypoint.
        {
          spec: "@preview/example:0.1.0",
          path: "typst.toml",
          data: '[package]\nname = "example"\nversion = "0.1.0"\nentrypoint = "lib.typ"\n',
        },
        {
          spec: "@preview/example:0.1.0",
          path: "lib.typ",
          data: "#let greet(n) = [Hello, #n!]",
        },
      ],
    }).compileSync({
      source: '#import "@preview/example:0.1.0": greet\n#greet("world")',
    });

    assert.equal(result.ok, true, JSON.stringify(result.error));
  });

  it("returns a zero-copy Buffer that is complete", () => {
    const result = compiler().compileSync({ source: "= Big\n#lorem(2000)" });
    assert.ok(Buffer.isBuffer(result.pdf));
    assert.ok(result.pdf.length > 10_000, `only ${result.pdf.length} bytes`);
    // The trailer is the last thing written, so its presence proves the whole
    // buffer crossed rather than a truncated view of it.
    assert.ok(result.pdf.subarray(-32).includes("%%EOF"));
  });
});

describe("reproducibility", () => {
  it("produces byte-identical output when the clock and ident are pinned", () => {
    const c = compiler();
    const request = {
      source: "= Statement\n#lorem(20)",
      clock: { fixed: 1_785_888_000 },
      pdf: { ident: "statement-v1", timestamp: false },
    };
    assert.deepEqual(c.compileSync(request).pdf, c.compileSync(request).pdf);
  });

  it("surfaces an unavailable clock as a document error", () => {
    const result = compiler().compileSync({
      source: "#datetime.today().display()",
      clock: { unavailable: true },
    });
    // Better than a silently wrong date.
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "COMPILE_FAILED");
  });
});

describe("diagnostics", () => {
  it("carries structured positions across the boundary", () => {
    const result = compiler().compileSync({ source: "ok\n#undefined_function()" });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "COMPILE_FAILED");

    const [diagnostic] = result.error.diagnostics;
    assert.equal(diagnostic.severity, "error");
    assert.deepEqual(diagnostic.position, { file: "/main.typ", line: 2, column: 2 });
    assert.match(diagnostic.message, /unknown variable/u);
  });

  it("preserves hints", () => {
    const result = compiler().compileSync({ source: "#let (a, b) = (1,)" });
    const hints = result.error.diagnostics.flatMap((d) => d.hints);
    assert.ok(
      hints.some((h) => h.message.includes("length of 1")),
      JSON.stringify(result.error.diagnostics),
    );
  });

  it("preserves the trace through an import", () => {
    const result = compiler({
      files: { "/lib/broken.typ": "#let boom() = { undefined_thing }" },
    }).compileSync({ source: '#import "/lib/broken.typ": boom\n#boom()' });

    const [diagnostic] = result.error.diagnostics;
    assert.equal(diagnostic.position.file, "/lib/broken.typ");
    assert.ok(diagnostic.trace.length > 0, "trace was dropped");
    assert.equal(diagnostic.trace[0].position.file, "/main.typ");
  });

  it("reports warnings on a successful compile", () => {
    const result = compiler().compileSync({ source: "#show page: it => it\nhello" });

    assert.equal(result.ok, true);
    const warning = result.warnings.find((w) => w.message.includes("`show page`"));
    assert.ok(warning, JSON.stringify(result.warnings));
    assert.equal(warning.severity, "warning");
    assert.ok(warning.hints.some((h) => h.message.includes("set page(..)")));
  });
});

describe("PDF options", () => {
  it("makes untagged output smaller", () => {
    const c = compiler();
    const tagged = c.compileSync({ source: "= Tagged\n#lorem(120)", pdf: { tagged: true } });
    const untagged = c.compileSync({
      source: "= Untagged\n#lorem(120)",
      pdf: { tagged: false },
    });
    assert.ok(untagged.pdf.length < tagged.pdf.length);
  });

  it("rejects a page range on tagged output before compiling", () => {
    const result = compiler().compileSync({
      // Unparsable on purpose: if this reached typst the error would be a
      // syntax error rather than the settings error asserted below.
      source: "#(",
      pdf: { pageRanges: [{ start: 1, end: 1 }] },
    });
    assert.equal(result.error.code, "INVALID_PDF_SETTINGS");
  });

  it("exports a page range when untagged", () => {
    const c = compiler();
    const source =
      "#set page(width: 100pt, height: 60pt)\nfirst\n#pagebreak()\nsecond\n#pagebreak()\nthird";
    const all = c.compileSync({ source });
    const one = c.compileSync({
      source,
      pdf: { tagged: false, pageRanges: [{ start: 2, end: 2 }] },
    });
    assert.equal(all.pages, 3);
    assert.ok(one.pdf.length < all.pdf.length);
  });

  it("writes a custom creator", () => {
    const result = compiler().compileSync({
      source: "hello",
      pdf: { creator: "emquad-test", timestamp: false, pretty: true },
    });
    assert.ok(result.pdf.includes("emquad-test"));
  });

  it("throws on an unknown standard rather than guessing", () => {
    assert.throws(
      () => compiler().compileSync({ source: "hello", pdf: { standards: ["pdf/x"] } }),
      /unknown PDF standard/u,
    );
  });

  it("reports incompatible standards", () => {
    const result = compiler().compileSync({
      source: "hello",
      pdf: { standards: ["1.4", "2.0"] },
    });
    assert.equal(result.error.code, "INVALID_PDF_SETTINGS");
  });
});

describe("the pool", () => {
  it("produces identical output serially and in parallel", async () => {
    // The state that would break this is process-global: comemo's cache, the
    // FileId interner, and the font book are all shared across workers.
    const c = compiler({ poolSize: 4 });
    const requests = Array.from({ length: 16 }, (_, n) => ({
      source: `= Concurrent ${n}\n#lorem(${20 + n})`,
      clock: { fixed: 1_785_888_000 },
      pdf: { ident: "concurrent", timestamp: false },
    }));

    const serial = requests.map((r) => c.compileSync(r).pdf);
    const parallel = (await Promise.all(requests.map((r) => c.compile(r)))).map((r) => r.pdf);

    assert.deepEqual(serial, parallel);
  });

  it("refuses work rather than growing the queue without limit", async () => {
    // One worker, one queue slot. An unbounded queue would turn sustained
    // overload into an out-of-memory crash instead of a visible error.
    const c = compiler({ poolSize: 1, queueCapacity: 1 });
    const heavy = { source: "= Heavy\n#lorem(4000)" };

    const inflight = [];
    let refusal;
    for (let n = 0; n < 64; n += 1) {
      try {
        inflight.push(c.compile(heavy));
      } catch (error) {
        refusal = error;
        break;
      }
    }

    assert.ok(refusal, "the queue never filled");
    assert.match(refusal.message, /QUEUE_FULL/u);
    // Everything already accepted still completes.
    const settled = await Promise.all(inflight);
    assert.ok(settled.every((r) => r.ok));
  });

  it("keeps working after the queue has drained", async () => {
    const c = compiler({ poolSize: 2, queueCapacity: 4 });
    for (let round = 0; round < 3; round += 1) {
      const results = await Promise.all(
        Array.from({ length: 4 }, (_, n) => c.compile({ source: `round ${round}-${n}` })),
      );
      assert.ok(results.every((r) => r.ok));
    }
    assert.equal(c.stats.queued, 0);
  });
});

describe("failure containment", () => {
  it("surfaces a rust panic as a value instead of aborting the process", async () => {
    // Hard rule 2. A panic crossing into Node kills the process outright, so
    // this has to be demonstrated rather than claimed. `__panicInPool` exists
    // only under the `test-hooks` feature.
    const c = compiler({ poolSize: 1 });
    assert.equal(
      typeof c.__panicInPool,
      "function",
      "build with `pnpm --filter @emquad/binding run build:test`",
    );

    const result = await c.__panicInPool();
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "PANIC");
    assert.match(result.error.message, /deliberate panic/u);

    // The process is still alive and the pool still works.
    assert.equal((await c.compile({ source: "after the panic" })).ok, true);
  });

  it("reports a path vocabulary guard trip with the offending pattern", () => {
    // The guard exists because FileId is a process-global interner that leaks
    // every path and panics at 65,535. It must fail long before that.
    assert.equal(setPathLimit(600), 600);
    const c = compiler();

    let failure;
    for (let n = 0; n < 2000; n += 1) {
      const result = c.compileSync({
        source: "x",
        files: { [`/leak-${n.toString(16).padStart(8, "0")}-4a19.typ`]: "x" },
      });
      if (!result.ok) {
        failure = result.error;
        break;
      }
    }

    assert.ok(failure, "the guard never fired");
    assert.equal(failure.code, "PATH_VOCABULARY_EXHAUSTED");
    // Naming the pattern is the actionable part.
    assert.match(failure.message, /\/leak-\*-\*\.typ/u);
    assert.match(failure.message, /stable path/u);

    setPathLimit(50_000);
  });

  it("reports a missing main file by path", () => {
    const result = compiler().compileSync({ main: "/nowhere.typ" });
    assert.equal(result.error.code, "MAIN_NOT_FOUND");
    assert.match(result.error.message, /\/nowhere\.typ/u);
  });

  it("rejects a path that escapes the root", () => {
    const result = compiler().compileSync({
      source: "hello",
      files: { "../outside.typ": "leak" },
    });
    assert.equal(result.error.code, "INVALID_PATH");
  });
});

describe("the cache", () => {
  it("can be evicted by hand for compileSync callers", () => {
    // The pool evicts automatically; sync callers never touch it.
    const c = compiler({ poolSize: 1 });
    for (let n = 0; n < 20; n += 1) c.compileSync({ source: `= Doc ${n}\n#lorem(30)` });
    assert.doesNotThrow(() => evictCache(2));
    assert.doesNotThrow(() => evictCache());
    assert.equal(c.compileSync({ source: "still works" }).ok, true);
  });

  it("accepts false to disable eviction", () => {
    const c = compiler({ cacheMaxAge: false, poolSize: 1 });
    assert.equal(c.compileSync({ source: "no eviction" }).ok, true);
  });
});
