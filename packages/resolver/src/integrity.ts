import { createHash } from "node:crypto";

import type { PackageFile } from "#/types.ts";

/**
 * A content hash over an extracted package.
 *
 * Deliberately computed from the *files*, not from the tarball. The lockfile
 * has to be verifiable on every disk-cache read as well as on download, and by
 * the time a package is in the disk cache the tarball is long gone — hashing
 * the archive would mean the integrity check only ever ran on the one path
 * where it was least needed.
 *
 * Paths are sorted and length-delimited so that neither filesystem ordering nor
 * a path/content boundary ambiguity can change the result.
 */
export function integrityOf(files: readonly PackageFile[]): string {
  const hash = createHash("sha256");

  const sorted = files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of sorted) {
    const path = Buffer.from(file.path, "utf8");
    // Discriminated on `typeof`, not `Buffer.isBuffer`: a plain `Uint8Array`
    // is not a Buffer, and the negative branch of that check would still have
    // been bytes rather than the string the encoding argument implies.
    const data =
      typeof file.data === "string" ? Buffer.from(file.data, "utf8") : Buffer.from(file.data);
    // Length prefixes, so `{a, bc}` and `{ab, c}` cannot collide.
    hash.update(`${path.length}:`);
    hash.update(path);
    hash.update(`${data.length}:`);
    hash.update(data);
  }

  return `sha256-${hash.digest("base64")}`;
}
