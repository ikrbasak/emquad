// `@emquad/core` — the public API, over the in-process thread pool.
//
// The guiding principle from the testing strategy applies throughout: PDF
// generation fails silently far more often than it crashes. Asserting "no error
// thrown" would pass a blank page, so these check pages, bytes, and warnings.
//
// `try`/`finally` rather than `await using`: the syntax needs V8 13.8, so it
// parses only on Node 24 and up, while this package supports Node 22. The
// runtime half of the protocol is fine there — `Compiler` implements
// `Symbol.asyncDispose` and Node 22 has the symbol — it is purely the
// declaration form that Node 22's parser rejects, and it rejects it at load
// time, so a single `await using` anywhere takes the whole file down.

import assert from "node:assert/strict";
import { test } from "node:test";

import { Compiler, EmquadError, typstVersion } from "../dist/index.js";
import {
  BROKEN,
  CLOCK,
  FONTS,
  HELLO,
  INVOICE,
  REPRODUCIBLE,
  TEXT_FONTS,
  WARNS,
} from "./fixtures.js";

function compiler(options = {}) {
  return new Compiler({ fonts: TEXT_FONTS, ...options });
}

test("compiles a document to a PDF", async () => {
  const c = compiler();
  try {
    const { pdf, pages, warnings } = await c.document().source(HELLO).compile();

    assert.ok(Buffer.isBuffer(pdf));
    assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.ok(pdf.length > 1000, `suspiciously small PDF: ${pdf.length} bytes`);
    assert.equal(pages, 1);
    assert.deepEqual(warnings, []);
  } finally {
    await c.close();
  }
});

test("embeds a font rather than dropping the text", async () => {
  const c = compiler();
  try {
    const { pdf } = await c.document().source(HELLO).compile();
    // The failure this guards against is typst's worst: with no usable font it
    // emits a valid PDF with every text run silently dropped and zero
    // diagnostics. A PDF that embeds a font subset cannot have done that.
    assert.match(pdf.toString("latin1"), /FontFile|LibertinusSerif/u);
  } finally {
    await c.close();
  }
});

test("compileSync matches compile", async () => {
  const c = compiler();
  try {
    const sync = c.document().source(HELLO).clock(CLOCK).compileSync(REPRODUCIBLE);
    const async_ = await c.document().source(HELLO).clock(CLOCK).compile(REPRODUCIBLE);
    assert.deepEqual(sync.pdf, async_.pdf);
  } finally {
    await c.close();
  }
});

test("a pinned clock makes output byte-reproducible", async () => {
  const c = compiler();
  try {
    const first = await c.document().source(HELLO).clock(CLOCK).compile(REPRODUCIBLE);
    const second = await c.document().source(HELLO).clock(CLOCK).compile(REPRODUCIBLE);
    assert.deepEqual(first.pdf, second.pdf);
  } finally {
    await c.close();
  }
});

test("data() mounts JSON the document reads with json()", async () => {
  const c = compiler();
  try {
    const { pdf, pages } = await c
      .document()
      .source(INVOICE)
      .data({
        number: "INV-1024",
        total: 54,
        lines: [
          { name: "Widget", price: 12 },
          { name: "Gadget", price: 42 },
        ],
      })
      .compile();

    assert.equal(pages, 1);
    assert.ok(pdf.length > 1000);
  } finally {
    await c.close();
  }
});

test("data() rejects a value JSON cannot represent", async () => {
  const c = compiler();
  try {
    const cyclic = {};
    cyclic.self = cyclic;
    assert.throws(
      () => c.document().data(cyclic),
      (error) => {
        assert.ok(error instanceof EmquadError);
        assert.equal(error.code, "INVALID_ARGUMENT");
        return true;
      },
    );
  } finally {
    await c.close();
  }
});

test("warnings ride along with a successful compile", async () => {
  const c = compiler();
  try {
    const { pdf, warnings } = await c.document().source(WARNS).compile();

    assert.ok(pdf.length > 0);
    // The whole reason warnings are returned rather than dropped: an unmatched
    // font family produces a perfectly valid PDF set in a substituted font.
    // Nothing about the bytes would tell you.
    assert.ok(warnings.length > 0, "expected a warning about the unknown font family");
    assert.equal(warnings[0].severity, "warning");
    assert.match(warnings[0].message, /font/iu);
  } finally {
    await c.close();
  }
});

test("a failed compile throws EmquadError with real fields", async () => {
  const c = compiler();
  try {
    await assert.rejects(
      () => c.document().source(BROKEN).compile(),
      (error) => {
        assert.ok(error instanceof EmquadError);
        assert.equal(error.name, "EmquadError");
        assert.equal(error.code, "COMPILE_FAILED");

        // Structured, not a formatted string. This is the contract Phase 2
        // deliberately left to this layer.
        assert.equal(error.file, "/main.typ");
        assert.equal(error.line, 2);
        assert.equal(error.column, 6);
        assert.equal(error.severity, "error");
        assert.ok(Array.isArray(error.diagnostics));
        assert.equal(error.diagnostics.length, 1);
        assert.equal(error.diagnostics[0].position.file, "/main.typ");
        assert.match(error.summary, /^\/main\.typ:2:6: /u);
        return true;
      },
    );
  } finally {
    await c.close();
  }
});

test("diagnostics keep hints separate from the error", async () => {
  const c = compiler();
  try {
    await assert.rejects(
      () => c.document().source("#let (a, b) = (1,)").compile(),
      (error) => {
        assert.ok(error instanceof EmquadError);
        assert.ok(error.hints.length > 0, "expected a hint");
        // A hint routinely points at different code than the error it belongs
        // to; flattening the two into one message would lose the more useful.
        assert.equal(typeof error.hints[0].message, "string");
        return true;
      },
    );
  } finally {
    await c.close();
  }
});

test("an empty font set is refused at construction", () => {
  assert.throws(
    () => new Compiler({ fonts: [] }),
    (error) => {
      assert.ok(error instanceof EmquadError);
      assert.equal(error.code, "NO_FONTS");
      return true;
    },
  );
});

test("a document with no source refuses to compile", async () => {
  const c = compiler();
  try {
    await assert.rejects(
      () => c.document().compile(),
      (error) => {
        assert.equal(error.code, "INVALID_ARGUMENT");
        assert.match(error.message, /\.source\(/u);
        return true;
      },
    );
  } finally {
    await c.close();
  }
});

test("asset() rejects typst source", async () => {
  const c = compiler();
  try {
    assert.throws(
      () => c.document().asset("/template.typ", "= hi"),
      (error) => {
        assert.equal(error.code, "INVALID_ARGUMENT");
        assert.match(error.message, /use \.file\(\)/u);
        return true;
      },
    );
  } finally {
    await c.close();
  }
});

test("per-request files shadow the base layer without disturbing it", async () => {
  const c = compiler({ files: { "/logo.txt": "base" } });
  try {
    const overridden = await c
      .document()
      .source('#read("/logo.txt")')
      .file("/logo.txt", "tenant")
      .compile();
    const base = await c.document().source('#read("/logo.txt")').compile();

    // Same path, different bytes, and the base layer survives the override —
    // this is the mechanism that makes canonical paths workable.
    assert.ok(overridden.pdf.length > 0);
    assert.ok(base.pdf.length > 0);
    assert.notDeepEqual(overridden.pdf, base.pdf);
  } finally {
    await c.close();
  }
});

test("main() uses an existing file as the entrypoint", async () => {
  const c = compiler({ files: { "/template.typ": HELLO } });
  try {
    const { pages } = await c.document().main("/template.typ").compile();
    assert.equal(pages, 1);
  } finally {
    await c.close();
  }
});

test("pool.timeoutMs without process mode is an error, not a no-op", () => {
  assert.throws(
    () => new Compiler({ fonts: TEXT_FONTS, pool: { timeoutMs: 1000 } }),
    (error) => {
      assert.equal(error.code, "INVALID_ARGUMENT");
      // The message has to explain *why*, because the option looks reasonable.
      assert.match(error.message, /cannot be cancelled on a thread/u);
      return true;
    },
  );
});

test("tagged: true and pageRanges are rejected before compiling", async () => {
  const c = compiler();
  try {
    await assert.rejects(
      () =>
        c
          .document()
          .source(HELLO)
          .compile({ tagged: true, pageRanges: [{ start: 1 }] }),
      (error) => {
        assert.equal(error.code, "INVALID_PDF_SETTINGS");
        assert.ok(error.diagnostics.length > 0 || error.message.length > 0);
        return true;
      },
    );
  } finally {
    await c.close();
  }
});

test("concurrent compiles are deterministic", async () => {
  const c = compiler({ pool: { size: 4 } });
  try {
    const serial = await c.document().source(HELLO).clock(CLOCK).compile(REPRODUCIBLE);

    const parallel = await Promise.all(
      Array.from({ length: 16 }, () =>
        c.document().source(HELLO).clock(CLOCK).compile(REPRODUCIBLE),
      ),
    );

    // Snapshot isolation bugs would show up here and nowhere else.
    for (const result of parallel) assert.deepEqual(result.pdf, serial.pdf);
  } finally {
    await c.close();
  }
});

test("stats report the interner counters that predict a crash", async () => {
  const c = compiler();
  try {
    await c.document().source(HELLO).compile();
    const stats = await c.stats();

    assert.ok(stats.internedPaths > 0);
    assert.ok(stats.trackedPaths <= stats.internedPaths);
    assert.equal(stats.pathCap, 65_535);
    assert.ok(stats.pathLimit <= stats.pathCap);
  } finally {
    await c.close();
  }
});

test("fontFamilies reports what actually parsed", async () => {
  const c = compiler({ fonts: FONTS });
  try {
    const families = await c.fontFamilies();

    assert.ok(families.length > 0);
    // Typst does not lowercase family names, and a near-miss substitutes a font
    // silently rather than erroring — so this list is how a user diagnoses it.
    assert.ok(families.includes("New Computer Modern"), families.join(", "));
  } finally {
    await c.close();
  }
});

test("a closed compiler refuses new documents", async () => {
  const c = compiler();
  await c.close();
  await c.close(); // idempotent
  assert.throws(
    () => c.document(),
    (error) => {
      assert.equal(error.code, "SHUTTING_DOWN");
      return true;
    },
  );
});

test("typstVersion is the version this binary was built against", () => {
  assert.equal(typstVersion(), "0.15.1");
});
