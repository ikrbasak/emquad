// Clean-consumer packaging test.
//
// Packs the real tarball, unpacks it into a fresh `"type": "module"` project,
// and imports it the way a user would. It catches a specific class of bug that
// nothing else here can: an `exports` map that omits a path, a `files` list
// that drops `dist/worker.js`, or an ESM loader problem that never appears when
// tests import `../dist/index.js` by relative path.
//
// **What it does not yet cover.** The native addon is resolved through
// `@emquad/typst-binding`, which is still private: it cannot be published until
// the `@emquad/typst-binding-<platform>` packages it declares as
// `optionalDependencies` exist in a registry. Until then this links the
// workspace copy rather than installing. Everything above that line — the
// exports map, the file list, the ESM entry — is real and is what this asserts.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const CORE = fileURLToPath(new URL("..", import.meta.url));
const PACKAGES = fileURLToPath(new URL("../..", import.meta.url));

const temps = [];
after(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Run pnpm without going through its shell wrapper.
 *
 * On Windows the thing on `PATH` is `pnpm.CMD`, and Node refuses to spawn a
 * `.cmd` or `.bat` without `shell: true` — hardening from CVE-2024-27980 — so
 * `execFileSync("pnpm", …)` fails there with a bare `ENOENT` that reads as a
 * missing install. `npm_execpath` points at pnpm's own `.mjs` entry, which
 * `process.execPath` runs directly: no shell, no quoting, and demonstrably the
 * same pnpm that launched the suite. It is set by the `test` script, whether
 * that is run through turbo or on its own.
 */
function pnpm(args, options) {
  const entry = process.env.npm_execpath;
  return entry
    ? execFileSync(process.execPath, [entry, ...args], options)
    : execFileSync("pnpm", args, options);
}

async function consumer() {
  const root = await mkdtemp(join(tmpdir(), "emquad-consumer-"));
  temps.push(root);

  // `pnpm pack` honors the `files` list, so this is exactly the tarball that
  // would be published — not a copy of the working tree.
  const packed = pnpm(["pack", "--pack-destination", root], {
    cwd: CORE,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .at(-1);

  const modules = join(root, "node_modules", "@emquad");
  const target = join(modules, "core");
  mkdirSync(target, { recursive: true });
  execFileSync("tar", ["-xzf", packed, "-C", target, "--strip-components=1"]);

  // The two dependencies that are not part of what is being tested. Linked
  // rather than packed: `@emquad/typst-binding` is still private until the
  // platform packages exist, and `@emquad/fonts` is only here to give the
  // consumer something to compile.
  //
  // Directory name and package name diverge for the binding — it lives in
  // `packages/binding` but publishes as `@emquad/typst-binding` — so the two
  // are listed separately rather than one being derived from the other.
  for (const [dir, name] of [
    ["binding", "typst-binding"],
    ["fonts", "fonts"],
  ]) {
    symlinkSync(join(PACKAGES, dir), join(modules, name), "dir");
  }

  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module" }, null, 2),
  );

  return { root, target };
}

test("the packed tarball ships what it promises", async () => {
  const { target } = await consumer();

  // `dist/worker.js` is the one that would go missing quietly. It is only
  // reached by `child_process.fork` at runtime, so nothing at import time
  // would notice its absence — the process pool would just fail to start.
  for (const file of ["dist/index.js", "dist/index.d.ts", "dist/worker.js", "package.json"]) {
    assert.ok(existsSync(join(target, file)), `${file} is missing from the tarball`);
  }

  // Source must not ship. It would nearly double the tarball and the `#/…`
  // subpath imports in it resolve to files the published package does not have.
  assert.ok(!existsSync(join(target, "src")), "src/ should not be published");
  assert.ok(!readdirSync(target).includes("tsconfig.json"));
});

test("a clean ESM consumer can import and compile", async () => {
  const { root } = await consumer();

  writeFileSync(
    join(root, "main.mjs"),
    `import { Compiler, EmquadError, typstVersion } from "@emquad/core";
import { fontsFor } from "@emquad/fonts";

const compiler = new Compiler({ fonts: fontsFor("libertinus-serif") });
const { pdf, pages } = await compiler.document().source("= Hello").compile();
await compiler.close();

if (!(pdf instanceof Buffer) || pdf.length < 1000) throw new Error("bad pdf");
if (typeof EmquadError !== "function") throw new Error("EmquadError is not exported");
console.log(JSON.stringify({ pages, typst: typstVersion(), bytes: pdf.length }));
`,
  );

  const output = execFileSync(process.execPath, [join(root, "main.mjs")], {
    cwd: root,
    encoding: "utf8",
  });

  const result = JSON.parse(output.trim().split("\n").at(-1));
  assert.equal(result.pages, 1);
  assert.equal(result.typst, "0.15.1");
  assert.ok(result.bytes > 1000);
});

test("the worker entry resolves from the installed layout", async () => {
  const { root } = await consumer();

  writeFileSync(
    join(root, "pool.mjs"),
    `import { Compiler } from "@emquad/core";
import { fontsFor } from "@emquad/fonts";

// The path \`ProcessPool\` resolves for the worker is relative to the bundled
// \`dist/index.js\`. Nothing but running it from an installed layout proves
// that path is right.
const compiler = new Compiler({
  fonts: fontsFor("libertinus-serif"),
  pool: { mode: "process", size: 1 },
});
const { pages } = await compiler.document().source("= Hello").compile();
await compiler.close();
console.log(JSON.stringify({ pages }));
`,
  );

  const output = execFileSync(process.execPath, [join(root, "pool.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(JSON.parse(output.trim().split("\n").at(-1)).pages, 1);
});
