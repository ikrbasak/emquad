#!/usr/bin/env node
// Point `@emquad/typst-binding`'s `optionalDependencies` at the platform
// package versions that actually exist on disk.
//
//   node scripts/sync-binding-optional-deps.mjs           # write
//   node scripts/sync-binding-optional-deps.mjs --check   # fail if out of sync
//
// # Why this exists
//
// `napi version` bumps every `packages/binding/npm/*/package.json` to match the
// parent, and stops there. It does **not** touch the parent's
// `optionalDependencies`, and nothing else does either — the `0.0.1` bootstrap
// wrote them once by hand, from `scripts/initial-publish.sh`, so the gap never
// showed up.
//
// Left alone it fails silently and permanently: a `0.0.2` loader would publish
// with `optionalDependencies` still pinned to `0.0.1`, the freshly published
// `0.0.2` platform packages would have nothing depending on them, and every
// user would keep resolving the old binary. It installs, it loads, it compiles —
// with the previous release's native code, drifting further every version.
//
// Exact versions, not ranges: the loader and its binary are built from one
// source tree in one CI run, and a caret would let npm pair a loader with a
// binary it was never tested against.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const check = process.argv.includes("--check");
const root = fileURLToPath(new URL("..", import.meta.url));
const bindingDir = join(root, "packages", "binding");
const manifestPath = join(bindingDir, "package.json");
const npmDir = join(bindingDir, "npm");

const read = (path) => JSON.parse(readFileSync(path, "utf8"));

const manifest = read(manifestPath);
const targets = manifest.napi?.targets ?? [];

const platforms = readdirSync(npmDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => read(join(npmDir, entry.name, "package.json")));

// A missing directory here means a target was added to `napi.targets` without
// `napi create-npm-dirs` being re-run, which would publish a loader that looks
// for a package nobody ever generated.
if (platforms.length !== targets.length) {
  console.error(
    `packages/binding/npm has ${platforms.length} package(s) but napi.targets lists ` +
      `${targets.length}. Run \`napi create-npm-dirs\` in packages/binding.`,
  );
  process.exit(1);
}

const expected = Object.fromEntries(
  platforms.map((pkg) => [pkg.name, pkg.version]).toSorted(([a], [b]) => a.localeCompare(b)),
);

const stale = platforms.filter((pkg) => pkg.version !== manifest.version);
if (stale.length > 0) {
  console.error(
    `these platform packages are not at the loader's version (${manifest.version}): ` +
      stale.map((pkg) => `${pkg.name}@${pkg.version}`).join(", "),
  );
  console.error("run `pnpm --filter @emquad/typst-binding exec napi version` first.");
  process.exit(1);
}

const current = manifest.optionalDependencies ?? {};
const same =
  Object.keys(expected).length === Object.keys(current).length &&
  Object.entries(expected).every(([name, version]) => current[name] === version);

if (same) {
  console.log(`optionalDependencies already match (${manifest.version}).`);
  process.exit(0);
}

if (check) {
  console.error("packages/binding optionalDependencies are out of sync with npm/*.");
  for (const [name, version] of Object.entries(expected)) {
    if (current[name] !== version) {
      console.error(`  ${name}: ${current[name] ?? "(missing)"} -> ${version}`);
    }
  }
  console.error("run: node scripts/sync-binding-optional-deps.mjs");
  process.exit(1);
}

manifest.optionalDependencies = expected;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`synced ${Object.keys(expected).length} optionalDependencies to ${manifest.version}.`);
