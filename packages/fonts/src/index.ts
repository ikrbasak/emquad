/**
 * `@emquad/fonts` — the default Typst font set, shipped verbatim.
 *
 * ```ts
 * import { Compiler } from "@emquad/core";
 * import { defaultFonts } from "@emquad/fonts";
 *
 * const compiler = new Compiler({ fonts: defaultFonts });
 * ```
 *
 * ## This package is not MIT
 *
 * The rest of the workspace is. These 17 files carry **four** licenses, and one
 * of them — `NewCM10-Regular.otf` — is GPL-3.0-or-later. A Distribution
 * Exception is what makes it shippable inside a permissively licensed program,
 * and that exception is void the moment the glyphs or glyph-set are modified.
 *
 * So: **never subset, re-encode, or rewrite these files.** 9.3 MB is the
 * largest single item in the install footprint and subsetting is the obvious
 * way to shrink it — doing so would relicense this package as GPL-3. To reduce
 * size, drop whole families instead; {@link fontsExcept} exists for exactly
 * that. Full reasoning in `LICENSING.md`.
 *
 * @packageDocumentation
 */

import { fileURLToPath } from "node:url";

import { MANIFEST } from "#/manifest.ts";

export type { FontEntry } from "#/manifest.ts";
export { MANIFEST, TOTAL_BYTES, TYPST_ASSETS_VERSION } from "#/manifest.ts";

/**
 * A font `@emquad/core` can load.
 *
 * Declared structurally rather than imported, so this package stays a pure
 * data dependency with nothing to build against.
 */
export interface FontFile {
  file: string;
}

/** Absolute path to the directory holding the shipped font files. */
export const FONTS_DIR = fileURLToPath(new URL("../fonts/", import.meta.url));

/** The families in this package, as `@emquad/core` reports them. */
export type FontFamily = "libertinus-serif" | "new-computer-modern" | "dejavu-sans-mono";

function family(file: string): FontFamily {
  if (file.startsWith("Libertinus")) return "libertinus-serif";
  if (file.startsWith("DejaVu")) return "dejavu-sans-mono";
  return "new-computer-modern";
}

/**
 * All 17 faces, as path descriptors.
 *
 * Descriptors rather than bytes, deliberately. Nothing is read until a
 * `Compiler` is built, and under `pool.mode: "process"` the *path* is what
 * crosses the IPC channel — each worker opens the files itself, avoiding 77 MB
 * of IPC at eight workers. Measured at ~23 ms of startup; small, but free.
 */
export const defaultFonts: readonly FontFile[] = Object.freeze(
  MANIFEST.map((entry) => ({ file: FONTS_DIR + entry.file })),
);

/**
 * The subset of {@link defaultFonts} belonging to the given families.
 *
 * ```ts
 * // Text only: skips the three math faces, ~4 MB of the 9.3.
 * new Compiler({ fonts: fontsFor("libertinus-serif", "dejavu-sans-mono") });
 * ```
 */
export function fontsFor(...families: FontFamily[]): FontFile[] {
  const wanted = new Set(families);
  return MANIFEST.filter((entry) => wanted.has(family(entry.file))).map((entry) => ({
    file: FONTS_DIR + entry.file,
  }));
}

/**
 * {@link defaultFonts} minus whole families.
 *
 * This is the *sanctioned* way to make the font payload smaller. Dropping a
 * family is a packaging choice; subsetting a file is a license change.
 */
export function fontsExcept(...families: FontFamily[]): FontFile[] {
  const unwanted = new Set(families);
  return MANIFEST.filter((entry) => !unwanted.has(family(entry.file))).map((entry) => ({
    file: FONTS_DIR + entry.file,
  }));
}
