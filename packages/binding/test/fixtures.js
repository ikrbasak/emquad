// Shared fixtures for the binding tests.
//
// The default typst fonts are read from the `typst-assets` crate source in the
// cargo registry. That is deliberate: `@emquad/fonts` does not exist yet, and
// vendoring 9.3 MB of fonts into the repo to test a binding would be worse. The
// tests skip themselves with a clear message if the crate is not vendored.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Locate the vendored `typst-assets` crate, or return null. */
function assetsDir() {
  const meta = JSON.parse(
    // `fileURLToPath`, not `.pathname`: on Windows the latter yields
    // `/D:/a/emquad/emquad`, which is not a path. spawn reports a bad `cwd` as
    // ENOENT against the *executable*, so this surfaced as `spawnSync cargo
    // ENOENT` and read as a missing toolchain rather than a broken directory.
    execFileSync("cargo", ["metadata", "--format-version", "1"], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf8",
    }),
  );
  const pkg = meta.packages.find((p) => p.name === "typst-assets");
  if (!pkg) return null;
  const dir = join(pkg.manifest_path, "..", "files", "fonts");
  return existsSync(dir) ? dir : null;
}

let cached;

/**
 * The 17 default typst faces, as Buffers.
 *
 * Throws with an actionable message rather than returning an empty array: an
 * empty font set is exactly the failure this project exists to prevent, and a
 * test suite that silently ran without fonts would prove nothing.
 */
export function fonts() {
  if (cached) return cached;
  const dir = assetsDir();
  if (!dir) {
    throw new Error("typst-assets is not vendored; run `cargo fetch` before the binding tests");
  }
  cached = readdirSync(dir)
    .filter((name) => /^(LibertinusSerif|NewCM|DejaVu)/u.test(name))
    .map((name) => readFileSync(join(dir, name)));
  if (cached.length === 0) {
    throw new Error(`no fonts found in ${dir}`);
  }
  return cached;
}

export const INVOICE = `
#set page(width: 210mm, height: 297mm, margin: 20mm)
#set text(fill: rgb("#1a3a5a"))
= Invoice
#table(
  columns: 3, stroke: 0.5pt + rgb("#888888"),
  fill: (_, y) => if y == 0 { rgb("#eeeeff") },
  table.header([*Item*], [*Qty*], [*Price*]),
  [Widget], [3], [$12.00$],
)
#rect(fill: gradient.linear(rgb("#ff0000"), rgb("#0000ff")), width: 100%, height: 2cm)
`;

/** A 1x1 transparent PNG — the smallest thing that proves image decoding ran. */
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
