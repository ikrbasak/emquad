import { defineConfig } from "tsdown";

export default defineConfig({
  // Named entries, not paths. The keys decide the output filenames, which puts
  // `worker.js` directly beside `index.js` regardless of how the source tree
  // nests them — and `ProcessPool` resolves the worker as `./worker.js`
  // relative to its own bundle, so the two have to agree.
  entry: {
    index: "src/index.ts",
    worker: "src/pool/worker.ts",
  },
  format: "esm",
  platform: "node",
  target: "node22",
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: "dist",

  // Plain `.js` and `.d.ts`. The package is `"type": "module"`, so `.js` is
  // already unambiguously ESM and the `.mjs` default only adds a second
  // spelling for readers to reconcile.
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),

  deps: {
    // The native addon must stay external. Bundling it would break the
    // `createRequire`-relative resolution its generated loader depends on to
    // find the `.node` file.
    neverBundle: ["@emquad/binding"],
  },
});
