// A fully in-memory typst registry, plus the tar writer it needs.
//
// No network in the unit tests. The resolver takes its `fetch` as an option
// precisely so this is possible — the same seam a caller uses to supply a
// proxy-aware fetch.

import { gzipSync } from "node:zlib";

const BLOCK = 512;

function header(path, size) {
  const block = Buffer.alloc(BLOCK);
  block.write(path, 0, 100, "utf8");
  block.write("0000644\0", 100, 8, "latin1"); // mode
  block.write("0000000\0", 108, 8, "latin1"); // uid
  block.write("0000000\0", 116, 8, "latin1"); // gid
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "latin1");
  block.write("00000000000\0", 136, 12, "latin1"); // mtime
  block.write("0", 156, 1, "latin1"); // typeflag: regular file
  block.write("ustar\0", 257, 6, "latin1");
  block.write("00", 263, 2, "latin1");

  // The checksum is computed with the checksum field itself read as spaces.
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");

  return block;
}

/** Build a `.tar.gz` from `{ path: content }`. */
export function tarball(files, { prefix = "" } = {}) {
  const chunks = [];
  for (const [path, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    chunks.push(header(prefix + path, data.length), data);
    const padding = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  // Two zero blocks terminate the archive.
  chunks.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(chunks));
}

/**
 * A mock registry and the `fetch` that serves it.
 *
 * `calls` counts requests, which is what makes "the network is hit once per
 * version, never per compile" an assertion rather than a claim.
 */
export function registry(packages = {}) {
  const state = { calls: [], packages: new Map(Object.entries(packages)) };

  const fetch = async (url) => {
    state.calls.push(url);
    const body = state.packages.get(String(url));
    if (!body) {
      return new Response(null, { status: 404, statusText: "Not Found" });
    }
    return new Response(body, { status: 200 });
  };

  return {
    fetch,
    get calls() {
      return state.calls;
    },
    /** Serve `@preview/{name}:{version}` with the given files. */
    add(base, name, version, files, options) {
      state.packages.set(`${base}/preview/${name}-${version}.tar.gz`, tarball(files, options));
    },
    /** Replace a package's bytes, to simulate a registry serving new content. */
    replace(base, name, version, files) {
      state.packages.set(`${base}/preview/${name}-${version}.tar.gz`, tarball(files));
    },
  };
}

export const BASE = "https://registry.test";

/** A minimal but valid package: a manifest and an entrypoint. */
export function pkg(name, version, extra = {}) {
  return {
    "typst.toml": `[package]\nname = "${name}"\nversion = "${version}"\nentrypoint = "lib.typ"\n`,
    "lib.typ": `#let ${name.replaceAll("-", "_")} = "${version}"\n`,
    ...extra,
  };
}
