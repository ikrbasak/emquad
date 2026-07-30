// Clean-consumer packaging test.
//
// Packs the real tarball, unpacks it into a fresh `"type": "module"` project,
// and imports it the way a user would. It catches a specific class of bug that
// nothing else here can: an `exports` map that omits a path, a `files` list
// that drops `dist/worker.js`, or an ESM loader problem that never appears when
// tests import `../dist/index.js` by relative path.
//
// The addon is reached the way a published install reaches it: `@emquad/core`
// and `@emquad/typst-binding` are both packed, and a platform package is
// assembled beside them holding the only copy of the `.node`. That last part is
// what makes the test meaningful — the loader prefers
// `require("@emquad/typst-binding-<triple>")` and falls back to a `.node` lying
// beside `index.js`, and it was the *fallback* this exercised for as long as it
// symlinked the workspace directory. The fallback is the one branch a published
// user never takes.
//
// **What it still does not cover.** Nothing is fetched from a registry, so
// `optionalDependencies` resolution — the `os`/`cpu`/`libc` gating that decides
// which of the eight a user actually downloads — is not exercised here. That
// needs a real install on each platform.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

  // The binding is packed rather than symlinked, and its platform package is
  // built by hand below, so the loader takes the path a real install takes.
  //
  // Symlinking `packages/binding` wholesale — what this did before the platform
  // packages existed — puts the built `.node` right beside `index.js`, which is
  // the loader's *development* fallback. That branch is the one thing a
  // published user never reaches, so the resolution chain that actually ships
  // (`require("@emquad/typst-binding-<triple>")`) went untested.
  const bindingTarball = pnpm(["pack", "--pack-destination", root], {
    cwd: join(PACKAGES, "binding"),
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .at(-1);
  const binding = join(modules, "typst-binding");
  mkdirSync(binding, { recursive: true });
  execFileSync("tar", ["-xzf", bindingTarball, "-C", binding, "--strip-components=1"]);

  // Derived from whatever the build produced rather than recomputed from
  // `process.platform`/`arch`: reimplementing napi's triple would mean
  // reimplementing its musl detection, and getting that subtly wrong would make
  // the test pass against a name no real install uses.
  const built = readdirSync(join(PACKAGES, "binding")).find((f) => f.endsWith(".node"));
  assert.ok(built, "no built .node in packages/binding — run the binding build first");
  const triple = built.slice("emquad.".length, -".node".length);

  const platform = join(modules, `typst-binding-${triple}`);
  mkdirSync(platform, { recursive: true });
  writeFileSync(
    join(platform, "package.json"),
    JSON.stringify({
      name: `@emquad/typst-binding-${triple}`,
      version: JSON.parse(readFileSync(join(binding, "package.json"), "utf8")).version,
      main: built,
    }),
  );
  copyFileSync(join(PACKAGES, "binding", built), join(platform, built));

  // Only fonts stays a symlink — it is scenery, not the thing under test.
  symlinkSync(join(PACKAGES, "fonts"), join(modules, "fonts"), "dir");

  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module" }, null, 2),
  );

  return { root, target, binding, triple };
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

test("the binding ships the loader and no binaries", async () => {
  const { binding, triple } = await consumer();

  // 29 MB per target, sixteen copies, in a package every user installs
  // regardless of platform — that is what this guards. It is not hypothetical:
  // `npm pack` here produced a 226 MB tarball until `files` was set, and the
  // only reason the published 0.0.1 escaped is that `changeset publish` shells
  // out to pnpm, which honours `.gitignore` where npm does not. Relying on that
  // difference is how the platform-package split gets quietly undone.
  const shipped = readdirSync(binding);
  assert.deepEqual(
    shipped.filter((f) => f.endsWith(".node")),
    [],
    `binding tarball contains binaries: ${shipped.join(", ")}`,
  );
  assert.ok(
    !shipped.includes("npm"),
    "npm/ holds the platform packages' manifests, not this one's",
  );

  // And therefore the compile above could only have reached the addon through
  // `require("@emquad/typst-binding-<triple>")`. With no `.node` beside
  // `index.js`, the loader's development fallback is unreachable — which is the
  // point, because that fallback is the branch no published user ever takes.
  assert.ok(
    existsSync(join(binding, "..", `typst-binding-${triple}`, `emquad.${triple}.node`)),
    "the platform package should be the only source of the addon",
  );
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
