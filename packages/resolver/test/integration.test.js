// Resolver and compiler, end to end.
//
// The unit tests prove the resolver produces the right *files*. This proves
// typst can actually import them, which is a different claim and the one that
// caught the manifest requirement in the first place: a package mounted without
// its `typst.toml` resolves fine and then fails at import with a file-not-found
// naming a path the user never wrote.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { Compiler } from "@emquad/core";
import { fontsFor } from "@emquad/fonts";

import { Resolver } from "../dist/index.js";
import { BASE, registry } from "./registry.js";

const temps = [];
after(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "emquad-integration-"));
  temps.push(dir);
  return dir;
}

const GREET = {
  "typst.toml": '[package]\nname = "greet"\nversion = "1.0.0"\nentrypoint = "lib.typ"\n',
  "lib.typ": "#let greet(who) = [Hello, #who!]\n",
};

const NESTED = {
  "typst.toml": '[package]\nname = "card"\nversion = "2.0.0"\nentrypoint = "lib.typ"\n',
  "lib.typ": `#import "@preview/greet:1.0.0": greet
#let card(who) = rect(inset: 6pt, greet(who))
`,
};

test("a resolved package compiles", async () => {
  const reg = registry();
  reg.add(BASE, "greet", "1.0.0", GREET);

  const source = '#import "@preview/greet:1.0.0": greet\n#greet("world")';
  const resolver = new Resolver({
    registry: BASE,
    cacheDir: await tempDir(),
    fetch: reg.fetch,
  });

  const packages = await resolver.resolve(source);
  await using compiler = new Compiler({ fonts: fontsFor("libertinus-serif"), packages });
  const { pdf, pages, warnings } = await compiler.document().source(source).compile();

  assert.equal(pages, 1);
  assert.ok(pdf.length > 1000);
  assert.deepEqual(warnings, []);
});

test("a transitively resolved package compiles", async () => {
  const reg = registry();
  reg.add(BASE, "card", "2.0.0", NESTED);
  reg.add(BASE, "greet", "1.0.0", GREET);

  const source = '#import "@preview/card:2.0.0": card\n#card("world")';
  const resolver = new Resolver({
    registry: BASE,
    cacheDir: await tempDir(),
    fetch: reg.fetch,
  });

  const packages = await resolver.resolve(source);
  await using compiler = new Compiler({ fonts: fontsFor("libertinus-serif"), packages });
  const { pages } = await compiler.document().source(source).compile();

  // `card` imports `greet`, and only `card`'s own source says so. If the
  // transitive scan missed it, this fails at import rather than at resolve.
  assert.equal(pages, 1);
  assert.equal(reg.calls.length, 2);
});

test("a package mounted without its manifest fails at import", async () => {
  const reg = registry();
  reg.add(BASE, "greet", "1.0.0", GREET);

  const source = '#import "@preview/greet:1.0.0": greet\n#greet("world")';
  const resolver = new Resolver({
    registry: BASE,
    cacheDir: await tempDir(),
    fetch: reg.fetch,
  });

  const packages = await resolver.resolve(source);
  const withoutManifest = packages.filter((file) => file.path !== "typst.toml");

  await using compiler = new Compiler({
    fonts: fontsFor("libertinus-serif"),
    packages: withoutManifest,
  });

  // This is the error the manifest requirement exists to prevent, asserted so
  // the requirement stays justified rather than remembered.
  await assert.rejects(
    () => compiler.document().source(source).compile(),
    (error) => {
      assert.equal(error.code, "COMPILE_FAILED");
      assert.match(error.message, /typst\.toml/u);
      return true;
    },
  );
});

test("resolving is startup work, not per-compile work", async () => {
  const reg = registry();
  reg.add(BASE, "greet", "1.0.0", GREET);

  const source = '#import "@preview/greet:1.0.0": greet\n#greet("world")';
  const resolver = new Resolver({
    registry: BASE,
    cacheDir: await tempDir(),
    fetch: reg.fetch,
  });

  const packages = await resolver.resolve(source);
  await using compiler = new Compiler({ fonts: fontsFor("libertinus-serif"), packages });

  for (let i = 0; i < 50; i += 1) {
    await compiler.document().source(source).compile();
  }

  // Fifty compiles, one fetch. This is the shape the API is built around:
  // resolve once at startup, keep the compiler, and never touch the network
  // again.
  assert.equal(reg.calls.length, 1);
  assert.equal(resolver.networkFetches, 1);
});
