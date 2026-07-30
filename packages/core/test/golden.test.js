// Golden-file rendering comparisons.
//
// This is the primary defense against the failure mode that defines this
// project: **PDF generation fails silently far more often than it crashes.** A
// dropped glyph, a missing table header on page two, an image that decoded to
// nothing — all of them produce a valid PDF that a test asserting "no error
// thrown" would happily accept.
//
// So these tests render. Three assertions per fixture, in increasing order of
// how hard they are to fool:
//
//   1. page count      — cheap, catches gross layout changes
//   2. extracted text   — catches dropped or substituted text runs
//   3. rasterized pixels — catches everything else
//
// **Raw PDF bytes are deliberately not snapshotted.** They shift with every
// typst release and produce diffs no human can review, which trains reviewers
// to regenerate goldens without reading them — and a golden nobody reads is
// worse than no golden at all.
//
// Regenerating is explicit and never automatic:
//
//   UPDATE_GOLDENS=1 node --test "test/golden.test.js"
//
// On a mismatch, the actual render, the reference, and a diff mask are written
// to `test/golden/diff/` so the change can be judged as intent or regression.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as mupdf from "mupdf";

import { Compiler } from "../dist/index.js";
import { fontsFor } from "@emquad/fonts";

import { CLOCK, FONTS, REPRODUCIBLE } from "./fixtures.js";

const DIR = fileURLToPath(new URL("./golden/", import.meta.url));
const FIXTURES = join(DIR, "fixtures");
const REFS = join(DIR, "refs");
const DIFFS = join(DIR, "diff");
const ASSETS = join(DIR, "assets");

const UPDATE = Boolean(process.env["UPDATE_GOLDENS"]);

/**
 * Allowed fraction of differing pixels.
 *
 * Not zero. Rasterization is not bit-identical across CPU architectures —
 * antialiasing and subpixel positioning move by a unit here and there — and a
 * zero threshold would make this suite fail on every platform but the one the
 * goldens were generated on. A tenth of a percent is far below any real
 * regression: a missing table header or a dropped image moves thousands of
 * pixels, not tens.
 */
const MAX_DIFF_RATIO = 0.001;

/** Per-channel difference below this is treated as antialiasing noise. */
const CHANNEL_TOLERANCE = 12;

const assets = {
  "/assets/logo.png": readFileSync(join(ASSETS, "logo.png")),
  "/assets/photo.jpg": readFileSync(join(ASSETS, "photo.jpg")),
  "/assets/mark.svg": readFileSync(join(ASSETS, "mark.svg")),
};

const compiler = new Compiler({ fonts: FONTS, files: assets });

/** Render every page to an RGB pixmap plus its extracted text. */
function render(pdf) {
  const doc = mupdf.Document.openDocument(pdf, "application/pdf");
  const pages = [];
  for (let i = 0; i < doc.countPages(); i += 1) {
    const page = doc.loadPage(i);
    const pixmap = page.toPixmap(mupdf.Matrix.scale(1, 1), mupdf.ColorSpace.DeviceRGB, false, true);
    pages.push({
      text: page.toStructuredText().asText(),
      width: pixmap.getWidth(),
      height: pixmap.getHeight(),
      pixels: Buffer.from(pixmap.getPixels()),
      png: Buffer.from(pixmap.asPNG()),
    });
  }
  return pages;
}

/** Decode a reference PNG back to raw RGB samples for comparison. */
function decode(png) {
  const image = new mupdf.Image(new mupdf.Buffer(png));
  const pixmap = image.toPixmap();
  return {
    width: pixmap.getWidth(),
    height: pixmap.getHeight(),
    pixels: Buffer.from(pixmap.getPixels()),
    components: pixmap.getNumberOfComponents(),
  };
}

/**
 * Compare two RGB buffers, returning the differing fraction and a mask.
 *
 * The mask is what makes a failure reviewable — a bare percentage tells you
 * something changed but not whether a header disappeared or a hairline moved.
 */
function compare(actual, expected, width, height, components) {
  const mask = Buffer.alloc(width * height * 3, 0xff);
  let differing = 0;

  for (let i = 0; i < width * height; i += 1) {
    const a = i * 3;
    const e = i * components;
    const delta = Math.max(
      Math.abs(actual[a] - expected[e]),
      Math.abs(actual[a + 1] - expected[e + 1]),
      Math.abs(actual[a + 2] - expected[e + 2]),
    );
    if (delta > CHANNEL_TOLERANCE) {
      differing += 1;
      mask[a] = 0xff;
      mask[a + 1] = 0;
      mask[a + 2] = 0;
    }
  }

  return { ratio: differing / (width * height), differing, mask };
}

function writeDiff(name, page, actual, mask, width, height) {
  mkdirSync(DIFFS, { recursive: true });
  writeFileSync(join(DIFFS, `${name}-p${page}-actual.png`), actual.png);
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false);
  pixmap.getPixels().set(mask);
  writeFileSync(join(DIFFS, `${name}-p${page}-diff.png`), Buffer.from(pixmap.asPNG()));
}

const names = readdirSync(FIXTURES)
  .filter((file) => file.endsWith(".typ"))
  .map((file) => basename(file, ".typ"))
  .toSorted();

assert.ok(names.length > 0, "no golden fixtures found");

for (const name of names) {
  test(`golden: ${name}`, async () => {
    const source = readFileSync(join(FIXTURES, `${name}.typ`), "utf8");

    // Pinned clock and identifier, or the same document would render to
    // different bytes on every run and nothing here could hold.
    const { pdf, warnings } = await compiler
      .document()
      .source(source)
      .clock(CLOCK)
      .compile({ ...REPRODUCIBLE, tagged: false });

    assert.deepEqual(
      warnings.map((w) => w.message),
      [],
      "a golden fixture should compile cleanly",
    );

    const pages = render(pdf);
    const metaPath = join(REFS, `${name}.json`);

    if (UPDATE) {
      mkdirSync(REFS, { recursive: true });
      writeFileSync(
        metaPath,
        `${JSON.stringify({ pages: pages.length, text: pages.map((p) => p.text) }, null, 2)}\n`,
      );
      for (const [index, page] of pages.entries()) {
        writeFileSync(join(REFS, `${name}-p${index + 1}.png`), page.png);
      }
      return;
    }

    assert.ok(
      existsSync(metaPath),
      `no golden for ${name}; generate with UPDATE_GOLDENS=1 and review the result`,
    );
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));

    assert.equal(pages.length, meta.pages, "page count changed");

    for (const [index, page] of pages.entries()) {
      // Text before pixels: a dropped text run is the single most likely
      // silent failure, and "the text is wrong" is a far more useful report
      // than "0.4% of pixels differ".
      assert.equal(page.text, meta.text[index], `page ${index + 1} text changed`);

      const reference = decode(readFileSync(join(REFS, `${name}-p${index + 1}.png`)));
      assert.equal(page.width, reference.width, `page ${index + 1} width changed`);
      assert.equal(page.height, reference.height, `page ${index + 1} height changed`);

      const { ratio, differing, mask } = compare(
        page.pixels,
        reference.pixels,
        page.width,
        page.height,
        reference.components,
      );

      if (ratio > MAX_DIFF_RATIO) {
        writeDiff(name, index + 1, page, mask, page.width, page.height);
        assert.fail(
          `page ${index + 1} differs in ${differing} pixels ` +
            `(${(ratio * 100).toFixed(3)}% > ${MAX_DIFF_RATIO * 100}%). ` +
            `Artifacts written to test/golden/diff/. If this change is intended, ` +
            `regenerate with UPDATE_GOLDENS=1 and review the diff before committing.`,
        );
      }
    }
  });
}

// The documented silent-failure cases, from the testing strategy. Both produce
// a perfectly valid PDF; the only evidence anything went wrong is a warning.
test("an unavailable font family warns rather than silently substituting", async () => {
  const { pdf, warnings } = await compiler
    .document()
    .source('#set text(font: "Definitely Not Installed")\nHello')
    .compile();

  assert.ok(pdf.length > 0, "typst still produces a document");
  assert.ok(warnings.length > 0, "the substitution must be reported");
  assert.match(warnings[0].message, /font/iu);
});

/** Count non-white pixels — a crude but decisive "did anything get drawn". */
function inkPixels(pdf) {
  const doc = mupdf.Document.openDocument(pdf, "application/pdf");
  const pixmap = doc
    .loadPage(0)
    .toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false, true);
  const pixels = pixmap.getPixels();
  let ink = 0;
  for (let i = 0; i < pixels.length; i += 3) if (pixels[i] < 200) ink += 1;
  return ink;
}

const GHOST_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40">
  <text x="4" y="24" font-family="Nonexistent Face" font-size="14">glyphs</text>
</svg>`;

// SVG text is *not* covered by typst's diagnostics. These two tests pin down
// exactly what happens instead, because the behavior is a genuine
// silent-wrong-output hazard and the only protection available is a test that
// notices when it changes.
test("SVG text in an unregistered family falls back silently", async () => {
  const { pdf, warnings } = await compiler
    .document()
    .source('#image("/ghost.svg", width: 60pt)')
    .asset("/ghost.svg", GHOST_SVG)
    .compile({ tagged: false });

  // No warning at all. Typst substitutes a registered face and says nothing —
  // so a document whose SVG asks for a brand font it never got looks correct
  // and is not.
  assert.equal(warnings.length, 0, "typst has started warning here; update the findings doc");
  assert.ok(inkPixels(pdf) > 0, "text was substituted, not dropped");
});

test("SVG text vanishes entirely when no fallback face fits", async () => {
  // The severe case, and the one worth remembering: with only a monospace
  // family registered, the same SVG renders *nothing*. Valid PDF, zero
  // diagnostics, no glyphs. This is the failure mode that makes an empty font
  // set a hard error (rule 8) — it is the same class of bug, reachable with a
  // font set that is merely incomplete rather than empty.
  await using mono = new Compiler({ fonts: fontsFor("dejavu-sans-mono") });
  const { pdf, warnings } = await mono
    .document()
    .source('#image("/ghost.svg", width: 60pt)')
    .asset("/ghost.svg", GHOST_SVG)
    .compile({ tagged: false });

  assert.equal(warnings.length, 0);
  assert.equal(inkPixels(pdf), 0, "typst has changed how it handles this; re-measure");
});

test.after(async () => {
  await compiler.close();
});
