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

## Continuous integration

Four workflows under `.github/workflows/`. Validate changes with `actionlint`
(`brew install actionlint`) — it catches retired runner labels and expression syntax that a YAML
parser accepts happily.

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | PR, `main`, merge queue | lint, clippy, licenses, tests, conditionally the native matrix |
| `build-native.yml` | called by the other two | one job per shipping target |
| `nightly.yml` | 03:00 UTC, manual | soak, interner pressure, real registry, benchmarks, full matrix |
| `release.yml` | `v*` tag, manual | preflight, matrix, verify, publish |

Every job starts with `./.github/actions/setup`, a composite action that installs Node, enables
**corepack**, caches the pnpm store, and installs. corepack rather than `pnpm/action-setup`
because the version then comes from `packageManager` — one declaration that CI and every
developer machine resolve identically. The store is cached explicitly rather than through
`setup-node`'s `cache: pnpm`, which needs pnpm on `PATH` before it runs and therefore cannot work
with corepack; asking `pnpm store path` also keeps it correct on Windows.

**`ci` is a single required check.** It gates on `join(needs.*.result)` rather than enumerating
jobs, so branch protection does not have to be edited whenever a target is added. It treats
`skipped` as acceptable and `cancelled` as failure — `build-native` is legitimately skipped when a
PR does not touch the Rust tree.

**Jobs are ordered by how fast they can say no.** `lint` compiles nothing — oxfmt, oxlint,
commitlint, and `turbo run typecheck` — and reports in about a minute. Rust lints are a separate
job because they need a compile.

**The native matrix is conditional.** A `changes` job diffs against the PR base and only runs
`build-native` when `crates/`, `Cargo.*`, `rust-toolchain.toml`, `packages/binding/`, or
`.github/` changed. On `main` it always runs.

### Why the run is not slower than it is

Three things dominate CI cost on a project like this, and each is dealt with deliberately.

**The release LTO link is kept out of the test path.** `@emquad/binding`'s test script builds its
own addon with the `test-hooks` feature — so if `test` depended on `build`, every test job would
pay for a `lto = true, codegen-units = 1` link and then immediately overwrite the result with a
debug build. `turbo.json` therefore gives `build` no `^build` at all (nothing here needs another
package's output to build) and points the suites at `@emquad/binding#test` instead. From a clean
tree with a warm cargo cache, `pnpm turbo run test` now runs one debug build and finishes in
about eight seconds.

**The test matrix is not a cross product.** The addon is built against Node-API 9 and is
ABI-stable across Node majors, so the Node version exercises the JavaScript layer while the OS
exercises the native build. Full OS coverage runs on the floor version (22); the newer majors
(24, 26) run on Linux only. `cargo test` piggybacks on the three floor-version rows rather than
forming its own matrix, so the Rust suite still runs on every OS without a second set of jobs
each paying for their own build. The three Linux rows share one `rust-cache` key.

**Tools are downloaded, not compiled.** `cargo install cargo-about` took two and a half minutes
to build a tool that runs for twenty seconds; the prebuilt release binary is used instead, pinned
to 0.9.1 because the notices check compares generated output byte for byte.

### Things encoded in the workflows that are easy to get wrong

**Publish order is not recoverable.** Platform packages must reach the registry *before*
`@emquad/core`, or the first person to install it resolves `optionalDependencies` that do not
exist yet and silently gets no native binding. Republishing core does not repair an install that
already failed.

**`release.yml` refuses to run today, on purpose.** A preflight job checks that
`napi.packageName` is set and that `@emquad/core` no longer depends on the private
`@emquad/binding`, and fails with the specific fix rather than producing broken packages an hour
later.

**Only some targets can be smoke-tested.** Loading the addon requires the runner's architecture to
match the target's, so `aarch64-*-linux-*` and `aarch64-pc-windows-msvc` are build-only. The
matrix carries an explicit `smoke` flag rather than inferring it.

**`macos-15-intel`, not `macos-13`.** GitHub retired the latter, and `macos-latest` is arm64 —
building `x86_64-apple-darwin` there would cross-compile and lose the smoke test.

**Golden-file diffs are uploaded on failure.** Without the artifact a mismatch is a percentage
with nothing to look at, and "just regenerate the goldens" becomes the path of least resistance.
The references were generated on `aarch64-apple-darwin`; if a Linux or Windows runner exceeds the
0.1% threshold, read the diff mask before touching the threshold.

**Benchmarks are recorded, not asserted.** Shared runners are too noisy for a pass/fail
performance gate, and a flaky one gets muted rather than investigated. They write to the job
summary; read the trend.

**Dependabot ignores `typst*` and `comemo`.** Typst is pinned exactly because it is pre-1.0 and
breaks across minor releases. A bump is a deliberate change with a golden-file re-run, never an
automatic PR.

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
