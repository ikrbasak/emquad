# JS/TS tooling

The Rust side is unchanged — see [`../phase-1/04-tooling.md`](../phase-1/04-tooling.md). This
covers what Phase 3 added.

## The split: tsdown builds, tsc checks

```json
"build":     "tsdown",
"typecheck": "tsc"
```

`tsconfig.base.json` sets `noEmit: true`. TypeScript is used **purely as a type checker** and never
emits anything; `tsdown` (rolldown) produces the bundle and the rolled-up declarations.

The split is deliberate. Bundlers are fast and bad at type errors; `tsc` is thorough and slow.
Asking either to do the other's job gets you the worst of both — and a build that type-checks as a
side effect will eventually be run with checking disabled "for speed."

`tsc` is on the **pre-push** hook, not pre-commit: it is the only place type errors are caught, and
it is too slow to run on every commit.

## TypeScript 7

The native (Go) compiler, `latest` as of this writing. Two things it changed that matter:

- **`baseUrl` is removed.** `paths` entries are resolved relative to the tsconfig instead. The
  error message says so clearly, which is more than most removals manage.
- **`types: ["node"]` must be explicit.** Automatic `@types` discovery does not reliably reach the
  root store under pnpm's symlinked layout, and the failure presents as a wall of
  "Cannot find name 'process'" that reads like a missing dependency rather than a resolution
  setting. It is set once in `tsconfig.base.json`.

`tsdown` prints a warning that the TypeScript 7 API is experimental. Declaration emit works.

## Subpath imports: `#/*`

Declared twice, and both are required:

```jsonc
// packages/*/package.json — what Node resolves at runtime
"imports": { "#/*": "./src/*" }

// packages/*/tsconfig.json — what TypeScript resolves
"paths": { "#/*": ["./src/*"] }
```

```ts
import { localError } from "#/errors.ts";        // not ../../errors.ts
```

Node's own subpath-imports mechanism, not a bundler alias — which is why the `#` prefix is
mandatory rather than decorative. The specifiers disappear at build time because tsdown inlines
everything, so nothing resolves `#/…` at runtime in a published package.

Imports name **`.ts` files directly** (`allowImportingTsExtensions`, permitted because nothing
emits). The alternative — writing `.js` to mean `.ts` — is a standing source of confusion for
anyone reading source rather than build output.

## Bundle layout

```ts
entry: { index: "src/index.ts", worker: "src/pool/worker.ts" },
outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
deps: { neverBundle: ["@emquad/binding"] },
```

**Named entries, not paths.** The keys decide output filenames, which puts `dist/worker.js`
directly beside `dist/index.js` regardless of how the source tree nests them. `ProcessPool`
resolves the worker as `./worker.js` relative to its own bundle, so the two must agree — and
`test/packaging.test.js` runs the pool from an installed layout to prove they do.

**`.js`, not the `.mjs` default.** The packages are `"type": "module"`, so `.js` is already
unambiguously ESM; `.mjs` would only add a second spelling to reconcile.

**`@emquad/binding` stays external.** Bundling it would break the `createRequire`-relative
resolution its generated loader uses to find the `.node` file.

## turbo

```jsonc
"build":     { "dependsOn": ["^build"], "outputs": ["dist/**", "*.node", "index.js", "index.d.ts"] },
"typecheck": { "dependsOn": ["^build"] },
"test":      { "dependsOn": ["build", "^build"], "cache": false }
```

Declaring `*.node` as a build output is what makes this bearable: `@emquad/binding`'s build is a
several-minute LTO link, and turbo skips it on every run after the first.

`test` has `cache: false` on purpose. The suites read fixtures and write diff artifacts that turbo
does not track, and a cached test run that depends on untracked files reports a stale pass — the
one failure mode a test cache must not have.

## oxlint and oxfmt, in TypeScript

`oxlint.config.ts` and `oxfmt.config.ts`, both `export default defineConfig({…})`. Auto-discovered
by name; no flag needed. The former JSON files are gone.

Two rules are turned off with reasons, because both fight this codebase's house style rather than
catching anything:

- **`no-inline-comments`** — fields and branches are annotated with trailing comments throughout.
- **`max-lines`** is `{ max: 500, skipComments: true }`. Comments are a large share of the lines
  here by design; counting them toward a length limit would push explanation out of the files that
  need it most.

`**/scripts/**` joins `test` and `bench` in the relaxed override — a maintenance script reporting
what it did is the point of it, not a `no-console` violation.

One inline suppression exists, in `test/golden/make-assets.mjs`: `unicorn/prefer-math-trunc` on the
CRC-32 table. `>>> 0` there is an unsigned 32-bit coercion, not a truncation, and `Math.trunc` is
not a substitute — CRC values above 2³¹ come out of `^` as negative signed integers and PNG needs
the unsigned form.

## Golden files

```sh
node --test "test/golden.test.js"                    # verify
UPDATE_GOLDENS=1 node --test "test/golden.test.js"   # regenerate, then review
node test/golden/make-assets.mjs                     # regenerate the image assets
```

References live in `packages/core/test/golden/refs/` and are committed. On a mismatch the actual
render and a diff mask are written to `test/golden/diff/` (gitignored) so the change can be judged
as intent or regression.

Regeneration is never automatic. A golden nobody reads is worse than no golden at all, and a
workflow that regenerates on failure trains reviewers not to read them.

## Test commands worth knowing

```sh
pnpm test                                        # cargo test + turbo run test
pnpm turbo run test --filter @emquad/core        # one package
EMQUAD_NETWORK_TESTS=1 pnpm --filter @emquad/resolver test   # + the real registry
pnpm --filter @emquad/fonts run sync             # re-copy fonts after a typst bump
```

The resolver's real-registry test is opt-in and excluded from default runs. It is the only thing
that proves the URL shape and tarball layout match the actual registry rather than our mock of it,
so run it when either changes.
