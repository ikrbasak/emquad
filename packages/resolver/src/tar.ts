import { gunzipSync } from "node:zlib";

/**
 * A minimal reader for the `.tar.gz` files the typst registry serves.
 *
 * Hand-written rather than taken from npm. The format is 512-byte headers and
 * padded blocks — about eighty lines — and a tar library is a surprisingly
 * large amount of code to trust with archives fetched over the network. It also
 * keeps this package's dependency count at zero, which is the same argument
 * that keeps `-sys` crates out of the Rust tree.
 *
 * Only what the registry actually produces is supported: regular files,
 * directories, and GNU long names. Anything else is skipped rather than
 * guessed at.
 */

const BLOCK = 512;

export interface TarEntry {
  path: string;
  data: Buffer;
}

/** Read a NUL-terminated ASCII field. */
function str(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("latin1");
}

/** Read an octal numeric field. Empty means zero. */
function octal(block: Buffer, offset: number, length: number): number {
  const text = str(block, offset, length).trim();
  return text.length === 0 ? 0 : Number.parseInt(text, 8);
}

export function extractTarGz(archive: Buffer): TarEntry[] {
  return extractTar(gunzipSync(archive));
}

export function extractTar(tar: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | undefined;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);

    // Two consecutive zero blocks end the archive. One is enough to stop on:
    // a header with an empty name is not a file by any reading.
    if (header.every((byte) => byte === 0)) break;

    const name = str(header, 0, 100);
    const size = octal(header, 124, 12);
    const type = str(header, 156, 1) || "0";
    const prefix = str(header, 345, 155);

    offset += BLOCK;
    const data = tar.subarray(offset, offset + size);
    // Content is padded to a block boundary.
    offset += Math.ceil(size / BLOCK) * BLOCK;

    if (type === "L") {
      // GNU long name: this entry's content is the *next* entry's path.
      // Sliced at the first NUL rather than regex-trimmed — the padding is
      // control characters, which a regex literal cannot carry cleanly.
      const stop = data.indexOf(0);
      longName = data.subarray(0, stop === -1 ? data.length : stop).toString("utf8");
      continue;
    }

    const path = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = undefined;

    // "0" and "\0" are regular files; everything else — directories, symlinks,
    // pax headers — carries no content this package needs.
    if (type === "0" || type === "\0") {
      entries.push({ path, data: Buffer.from(data) });
    }
  }

  return entries;
}

/**
 * Strip the leading directory component, if every entry shares one.
 *
 * Registry tarballs are inconsistent about whether paths are rooted at the
 * package or at a `name-version/` directory, and typst expects the former —
 * `typst.toml` at the root. Getting this wrong produces a file-not-found for a
 * manifest that is sitting right there under one more level of nesting.
 */
export function stripCommonPrefix(entries: TarEntry[]): TarEntry[] {
  if (entries.length === 0) return entries;

  const first = entries[0]!.path.split("/")[0];
  if (!first) return entries;

  const shared = entries.every((entry) => entry.path.startsWith(`${first}/`));
  if (!shared) return entries;

  return entries.map((entry) => ({ ...entry, path: entry.path.slice(first.length + 1) }));
}
