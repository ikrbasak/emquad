import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  DEFAULT_REGISTRY,
  integrityOf,
  parseSpec,
  Resolver,
  ResolverError,
  scanSpecs,
  stripCommonPrefix,
  extractTarGz,
} from "../dist/index.js";
import { BASE, pkg, registry, tarball } from "./registry.js";

const temps = [];
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "emquad-resolver-"));
  temps.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

function setup(packages = [["cetz", "0.4.2", pkg("cetz", "0.4.2")]]) {
  const reg = registry();
  for (const [name, version, files, options] of packages) {
    reg.add(BASE, name, version, files, options);
  }
  return reg;
}

async function resolver(reg, options = {}) {
  return new Resolver({
    registry: BASE,
    cacheDir: options.cacheDir ?? (await tempDir()),
    fetch: reg.fetch,
    ...options,
  });
}

test("resolves a package and mounts its manifest", async () => {
  const reg = setup();
  const r = await resolver(reg);
  const files = await r.resolve('#import "@preview/cetz:0.4.2": canvas');

  assert.ok(files.length > 0);
  // Typst reads typst.toml to find the entrypoint. Without it an import fails
  // with a file-not-found naming a file the user never wrote.
  const manifest = files.find((f) => f.path === "typst.toml");
  assert.ok(manifest, "typst.toml must be mounted");
  assert.equal(manifest.spec, "@preview/cetz:0.4.2");
  assert.ok(files.some((f) => f.path === "lib.typ"));
});

test("the network is hit once per version, never per compile", async () => {
  const reg = setup();
  const r = await resolver(reg);
  const source = '#import "@preview/cetz:0.4.2": canvas';

  for (let i = 0; i < 25; i += 1) await r.resolve(source);

  // This is the core correctness claim of the caching design.
  assert.equal(r.networkFetches, 1);
  assert.equal(reg.calls.length, 1);
});

test("concurrent requests for one package share a single download", async () => {
  const reg = setup();
  const r = await resolver(reg);

  await Promise.all(
    Array.from({ length: 16 }, () => r.resolve('#import "@preview/cetz:0.4.2": canvas')),
  );

  // Without in-flight deduplication, concurrency alone would break the
  // once-per-version guarantee.
  assert.equal(reg.calls.length, 1);
});

test("a second resolver reuses the disk cache without touching the network", async () => {
  const reg = setup();
  const cacheDir = await tempDir();
  const source = '#import "@preview/cetz:0.4.2": canvas';

  const first = await resolver(reg, { cacheDir });
  await first.resolve(source);
  assert.equal(reg.calls.length, 1);

  // A fresh instance: cold memory, warm disk. This is what a process restart
  // looks like, and it must not re-download.
  const second = await resolver(reg, { cacheDir });
  const files = await second.resolve(source);

  assert.equal(second.networkFetches, 0);
  assert.equal(reg.calls.length, 1);
  assert.ok(files.some((f) => f.path === "typst.toml"));
});

test("offline mode fails cleanly on a miss", async () => {
  const reg = setup();
  const r = await resolver(reg, { mode: "offline" });

  await assert.rejects(
    () => r.resolve('#import "@preview/cetz:0.4.2": canvas'),
    (error) => {
      assert.ok(error instanceof ResolverError);
      assert.equal(error.code, "PACKAGE_NOT_CACHED");
      assert.equal(error.spec, "@preview/cetz:0.4.2");
      return true;
    },
  );
  // No attempt was made, rather than an attempt that was suppressed.
  assert.equal(reg.calls.length, 0);
});

test("offline mode serves a warm cache", async () => {
  const reg = setup();
  const cacheDir = await tempDir();
  const source = '#import "@preview/cetz:0.4.2": canvas';

  await (await resolver(reg, { cacheDir })).resolve(source);
  const offline = await resolver(reg, { cacheDir, mode: "offline" });
  const files = await offline.resolve(source);

  assert.ok(files.length > 0);
  assert.equal(offline.networkFetches, 0);
});

test("transitive imports are followed", async () => {
  const reg = setup([
    ["outer", "1.0.0", pkg("outer", "1.0.0", { "lib.typ": '#import "@preview/inner:2.0.0": x\n' })],
    ["inner", "2.0.0", pkg("inner", "2.0.0")],
  ]);
  const r = await resolver(reg);

  const files = await r.resolve('#import "@preview/outer:1.0.0": y');
  const specs = new Set(files.map((f) => f.spec));

  // Nothing but the package's own source declares this dependency, so the
  // resolver has to read what it just downloaded to find it.
  assert.deepEqual([...specs].toSorted(), ["@preview/inner:2.0.0", "@preview/outer:1.0.0"]);
});

test("a lockfile mismatch is rejected, and nothing is installed", async () => {
  const reg = setup();
  const cacheDir = await tempDir();
  const lockfile = join(await tempDir(), "typst.lock.json");
  await writeFile(
    lockfile,
    JSON.stringify({
      version: 1,
      packages: { "@preview/cetz:0.4.2": { integrity: "sha256-wrong", files: 2 } },
    }),
  );

  const r = await resolver(reg, { cacheDir, lockfile });
  await assert.rejects(
    () => r.resolve('#import "@preview/cetz:0.4.2": canvas'),
    (error) => {
      assert.equal(error.code, "INTEGRITY_MISMATCH");
      assert.match(error.message, /nothing has been installed/u);
      return true;
    },
  );

  // The rejected package must not have reached the cache, or the next run
  // would find it there and be checked against the same bad hash.
  const offline = await resolver(reg, { cacheDir, mode: "offline" });
  await assert.rejects(() => offline.resolve('#import "@preview/cetz:0.4.2": x'), {
    code: "PACKAGE_NOT_CACHED",
  });
});

test("integrity is verified on disk reads, not only on download", async () => {
  const reg = setup();
  const cacheDir = await tempDir();
  const lockfile = join(await tempDir(), "typst.lock.json");
  const source = '#import "@preview/cetz:0.4.2": canvas';

  // Populate the cache and record what was installed.
  const first = await resolver(reg, { cacheDir, lockfile, updateLockfile: true });
  await first.resolve(source);
  await first.save();

  // Now corrupt the cached copy, as a bad disk or a stale shared cache would.
  await writeFile(join(cacheDir, "preview", "cetz", "0.4.2", "lib.typ"), "tampered");

  const second = await resolver(reg, { cacheDir, lockfile });
  await assert.rejects(() => second.resolve(source), { code: "INTEGRITY_MISMATCH" });
});

test("the lockfile records what was resolved", async () => {
  const reg = setup();
  const lockfile = join(await tempDir(), "typst.lock.json");
  const r = await resolver(reg, { lockfile, updateLockfile: true });

  await r.resolve('#import "@preview/cetz:0.4.2": canvas');
  await r.save();

  const written = JSON.parse(await readFile(lockfile, "utf8"));
  assert.equal(written.version, 1);
  assert.match(written.packages["@preview/cetz:0.4.2"].integrity, /^sha256-/u);
});

test("the lockfile is not rewritten unless asked", async () => {
  const reg = setup();
  const lockfile = join(await tempDir(), "typst.lock.json");
  const r = await resolver(reg, { lockfile });

  await r.resolve('#import "@preview/cetz:0.4.2": canvas');
  await r.save();

  // Silently updating would turn every integrity mismatch into a lockfile
  // update, which is precisely what a lockfile is for preventing.
  await assert.rejects(() => readFile(lockfile, "utf8"), { code: "ENOENT" });
});

test("vendor mode reads only the vendor directory", async () => {
  const reg = setup();
  const vendorDir = await tempDir();
  const r = await resolver(reg, { mode: "vendor", vendorDir });

  await assert.rejects(() => r.resolve('#import "@preview/cetz:0.4.2": canvas'), {
    code: "PACKAGE_NOT_CACHED",
  });
  assert.equal(reg.calls.length, 0);
});

test("vendor mode serves a vendored package", async () => {
  const reg = setup();
  const vendorDir = await tempDir();
  // Reuse the cache writer's layout: {namespace}/{name}/{version}.
  const seed = await resolver(reg, { cacheDir: vendorDir });
  await seed.resolve('#import "@preview/cetz:0.4.2": canvas');

  const r = await resolver(reg, { mode: "vendor", vendorDir });
  const files = await r.resolve('#import "@preview/cetz:0.4.2": canvas');

  assert.ok(files.some((f) => f.path === "typst.toml"));
  assert.equal(r.networkFetches, 0);
});

test("vendor mode without a directory is refused at construction", () => {
  assert.throws(() => new Resolver({ mode: "vendor" }), { code: "INVALID_SPEC" });
});

test("a missing package reports the registry's answer", async () => {
  const reg = setup();
  const r = await resolver(reg);
  await assert.rejects(
    () => r.resolve('#import "@preview/nope:9.9.9": x'),
    (error) => {
      assert.equal(error.code, "PACKAGE_NOT_FOUND");
      assert.match(error.message, /404/u);
      return true;
    },
  );
});

test("a package without a manifest is refused at download", async () => {
  const reg = registry();
  reg.add(BASE, "broken", "1.0.0", { "lib.typ": "#let x = 1" });
  const r = await resolver(reg);

  // Caught here rather than at import time, where it surfaces as a
  // file-not-found for a path the user never wrote.
  await assert.rejects(() => r.resolve('#import "@preview/broken:1.0.0": x'), {
    code: "INVALID_PACKAGE",
  });
});

test("a network failure is reported as one", async () => {
  const r = new Resolver({
    registry: BASE,
    cacheDir: await tempDir(),
    fetch: () => Promise.reject(new Error("ECONNREFUSED")),
  });
  await assert.rejects(() => r.resolve('#import "@preview/cetz:0.4.2": x'), {
    code: "NETWORK_ERROR",
  });
});

test("tarballs rooted at a name-version directory are flattened", async () => {
  const reg = registry();
  // Registries are inconsistent about this, and typst needs typst.toml at the
  // package root.
  reg.add(BASE, "nested", "1.0.0", pkg("nested", "1.0.0"), { prefix: "nested-1.0.0/" });
  const r = await resolver(reg);

  const files = await r.resolve('#import "@preview/nested:1.0.0": x');
  assert.ok(files.some((f) => f.path === "typst.toml"));
  assert.ok(!files.some((f) => f.path.includes("nested-1.0.0/")));
});

test("scanSpecs finds every distinct spec once", () => {
  const source = `
    #import "@preview/cetz:0.4.2": canvas
    #import "@preview/cetz:0.4.2": draw
    #import "@preview/tablex:0.0.9": tablex
  `;
  assert.deepEqual(scanSpecs(source).toSorted(), ["@preview/cetz:0.4.2", "@preview/tablex:0.0.9"]);
});

test("parseSpec rejects anything typst would not accept", () => {
  assert.deepEqual(parseSpec("@preview/cetz:0.4.2"), {
    namespace: "preview",
    name: "cetz",
    version: "0.4.2",
  });
  for (const bad of ["cetz:0.4.2", "@preview/cetz", "@preview/cetz:^0.4", "@preview/Cetz:0.4.2"]) {
    assert.throws(() => parseSpec(bad), /invalid package spec/u);
  }
});

test("integrity is order-independent and boundary-safe", () => {
  const a = [
    { spec: "s", path: "a", data: "x" },
    { spec: "s", path: "b", data: "y" },
  ];
  assert.equal(integrityOf(a), integrityOf(a.toReversed()));

  // Length-prefixed, so {a, bc} and {ab, c} cannot collide.
  assert.notEqual(
    integrityOf([{ spec: "s", path: "a", data: "bc" }]),
    integrityOf([{ spec: "s", path: "ab", data: "c" }]),
  );
});

test("the tar reader handles padding and long names", () => {
  const long = `${"deep/".repeat(30)}file.typ`;
  const files = { "typst.toml": "x", "lib.typ": "y".repeat(1000), [long]: "z" };
  const entries = extractTarGz(tarball(files));

  assert.equal(entries.length, 3);
  assert.equal(entries.find((e) => e.path === "lib.typ").data.length, 1000);
});

test("stripCommonPrefix leaves already-flat archives alone", () => {
  const flat = [
    { path: "typst.toml", data: Buffer.alloc(0) },
    { path: "lib.typ", data: Buffer.alloc(0) },
  ];
  assert.deepEqual(stripCommonPrefix(flat), flat);
});

test("the default registry is the public one", () => {
  assert.equal(DEFAULT_REGISTRY, "https://packages.typst.org");
});

// Opt-in, and excluded from default runs. It is the only thing here that
// proves the URL shape and tarball layout match the real registry rather than
// our mock of it.
test("hits the real registry", { skip: !process.env["EMQUAD_NETWORK_TESTS"] }, async () => {
  const r = new Resolver({ cacheDir: await tempDir() });
  const files = await r.resolve('#import "@preview/cetz:0.4.2": canvas');
  assert.ok(files.some((f) => f.path === "typst.toml"));
});
