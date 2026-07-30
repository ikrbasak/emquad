// The packaging test that hard rule 11 depends on.
//
// Its whole job is to make "ship the fonts byte-for-byte" mechanically
// enforced. `NewCM10-Regular.otf` is GPL-3.0-or-later, and the Distribution
// Exception that lets this package carry it is void if the glyphs or glyph-set
// are modified — so a build step that helpfully subset the fonts to save space
// would silently relicense the package as GPL-3. A checksum catches that; a
// code review might not.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  defaultFonts,
  FONTS_DIR,
  fontsExcept,
  fontsFor,
  MANIFEST,
  TOTAL_BYTES,
  TYPST_ASSETS_VERSION,
} from "../dist/index.js";

const LICENSES_DIR = fileURLToPath(new URL("../licenses/", import.meta.url));

test("every shipped font matches its recorded checksum", () => {
  for (const entry of MANIFEST) {
    const bytes = readFileSync(join(FONTS_DIR, entry.file));
    assert.equal(bytes.length, entry.bytes, `${entry.file} size changed`);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      entry.sha256,
      `${entry.file} content changed — if this was a subsetting or optimization step, ` +
        "revert it: modifying these files relicenses @emquad/fonts as GPL-3",
    );
  }
});

test("the fonts directory holds exactly the manifest, nothing more", () => {
  const onDisk = readdirSync(FONTS_DIR).toSorted();
  const declared = MANIFEST.map((entry) => entry.file).toSorted();
  assert.deepEqual(onDisk, declared);
});

test("the manifest is the 17 faces typst_assets::fonts() yields", () => {
  assert.equal(MANIFEST.length, 17);
  assert.equal(defaultFonts.length, 17);
  assert.equal(
    MANIFEST.reduce((sum, entry) => sum + entry.bytes, 0),
    TOTAL_BYTES,
  );
});

test("the license breakdown is the four licenses, in the documented split", () => {
  const counts = {};
  for (const entry of MANIFEST) counts[entry.license] = (counts[entry.license] ?? 0) + 1;

  // Matches the table in LICENSING.md. A change here means the upstream font
  // set changed, which is a licensing review, not a version bump.
  assert.deepEqual(counts, {
    "OFL-1.1": 6,
    "LPPL-1.3c": 6,
    "GPL-3.0-or-later": 1,
    "Bitstream-Vera": 4,
  });
});

test("the GPL-3 file is the one we think it is", () => {
  const gpl = MANIFEST.filter((entry) => entry.license === "GPL-3.0-or-later");
  assert.deepEqual(
    gpl.map((entry) => entry.file),
    ["NewCM10-Regular.otf"],
  );
});

test("the license texts ship", () => {
  const notice = readFileSync(join(LICENSES_DIR, "NOTICE"), "utf8");
  // The NOTICE from typst-assets carries all four texts verbatim. Spot-check
  // one distinctive phrase from each rather than the whole file.
  assert.match(notice, /SIL OPEN FONT LICENSE Version 1\.1/u);
  assert.match(notice, /GUST Font License/u);
  assert.match(notice, /GNU GENERAL PUBLIC LICENSE/u);
  assert.match(notice, /Bitstream Vera/u);
});

test("package.json declares the licenses honestly", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  // Not MIT, unlike the rest of the workspace. Stating otherwise would be a
  // false claim about redistributable terms.
  assert.equal(pkg.license, "OFL-1.1 AND LPPL-1.3c AND GPL-3.0-or-later AND Bitstream-Vera");
  assert.ok(pkg.files.includes("fonts"));
  assert.ok(pkg.files.includes("licenses"));
});

test("selectors partition the set", () => {
  const text = fontsFor("libertinus-serif", "dejavu-sans-mono");
  const math = fontsExcept("libertinus-serif", "dejavu-sans-mono");
  assert.equal(text.length + math.length, defaultFonts.length);
  assert.equal(text.length, 10);
  assert.equal(fontsFor().length, 0);
  assert.equal(fontsExcept().length, 17);
});

test("descriptors point at files that exist", () => {
  for (const font of defaultFonts) {
    assert.ok(existsSync(font.file), `${font.file} is missing`);
  }
});

// The strongest form of the check: compare against the original crate rather
// than against our own recorded hash, which would also pass if both were wrong.
// Skipped when the crate is not vendored, since that is a normal state for a
// consumer running these tests from a tarball.
test("fonts are byte-identical to typst-assets", (t) => {
  let dir;
  try {
    const meta = JSON.parse(
      execFileSync("cargo", ["metadata", "--format-version", "1"], {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        maxBuffer: 64 * 1024 * 1024,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
    const pkg = meta.packages.find((p) => p.name === "typst-assets");
    if (!pkg) {
      t.skip("typst-assets is not vendored");
      return;
    }
    assert.equal(pkg.version, TYPST_ASSETS_VERSION, "run `pnpm sync` after bumping typst");
    dir = join(pkg.manifest_path, "..", "files", "fonts");
  } catch {
    t.skip("cargo is unavailable");
    return;
  }

  for (const entry of MANIFEST) {
    assert.deepEqual(
      readFileSync(join(FONTS_DIR, entry.file)),
      readFileSync(join(dir, entry.file)),
      `${entry.file} differs from its typst-assets original`,
    );
  }
});
