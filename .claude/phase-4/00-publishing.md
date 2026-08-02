# Phase 4 — the first publish

`0.0.1` is on npm. Twelve packages, published 2026-07-30.

| Package | What it carries |
|---|---|
| `@emquad/core` | The API and both pools. Depends on `@emquad/typst-binding` at an exact version |
| `@emquad/typst-binding` | The napi loader and declarations. No binary of its own |
| `@emquad/typst-binding-<platform>` | Eight of them, one `.node` each, gated by `os`/`cpu`/`libc` |
| `@emquad/fonts` | The 17 default faces |
| `@emquad/resolver` | The `@preview` registry client |

`workspace:*` became `"@emquad/typst-binding": "0.0.1"` in the published
`@emquad/core`, which is pnpm rewriting it at pack time. That is the mechanism
the `fixed` changeset group exists to keep honest — the two must move together
or core pins a binding version that was never released.

## What the bootstrap cost, and why

Six defects, none of which any local check could have caught, because every one
of them lives in the gap between "the repo is correct" and "the registry
accepts it". Recorded in the order they bit.

**OIDC cannot create a package.** npm's trusted publishing is configured in a
package's settings page, and that page needs the package to exist
([npm/cli#8544](https://github.com/npm/cli/issues/8544), open). So the first
release of every package must use a token, and only then can OIDC take over.
This is why `scripts/initial-publish.sh` exists at all, and why the token in
`release.yml` is a fallback that can never be deleted outright.

**pnpm cannot lock a specifier no registry serves.** It drops an unresolvable
optional dependency and never writes it to the lockfile, so declaring the eight
platform packages before publishing them makes `--frozen-lockfile` fail in
every CI job, permanently. This is what forces the bootstrap into two landings:
publish the platform packages, *then* commit their declaration. It is also why
`packages/binding` was `private` until the moment it wasn't.

**A scoped package publishes as `restricted` by default**, and restricted needs
a paid org, so npm answers **402 Payment Required** — which says nothing about
visibility and reads like a billing problem. Changesets has its own `access`
setting but `napi` does not read it. `publishConfig.access` in each manifest is
the tool-independent spelling, and napi propagates it from the binding manifest
into the generated platform packages.

**`napi pre-publish` must run from `packages/binding`.** pnpm links napi's bin
only into that package and never hoists it, and every napi path option is
relative to the working directory — so from the repo root it fails to resolve,
and if it did resolve it would read the wrong `package.json` and look for a
top-level `npm/`. Also `--skip-gh-release` is the napi-rs v2 spelling; v3
inverted it to an opt-in `--gh-release` and rejects the old name outright.

**`napi pre-publish` is all-or-nothing.** It shells out to `npm publish` for
every platform package, and npm refuses to republish an existing version — so
a run that dies partway can never be restarted. It died partway. The script now
publishes each platform package individually, skipping those already up.

**A package's first version is served minutes behind its publish.**
npmjs.com listed the last two platform packages while `registry.npmjs.org` still
404'd their packuments. A 120-second readiness poll expired six packages in, and
the resulting state — six published, two not, no way to resume — was the worst
moment of the exercise. The poll is now ten minutes and uses `curl` rather than
`npm view`, so npm's HTTP cache cannot report a served package as missing.

The general lesson is that **`--dry-run` proved almost nothing here.** The
script's dry run only prints commands; three of the six defects were reachable
solely through `--execute`, which is the one path that cannot be rehearsed. The
preconditions that *did* pay off were the ones asserting registry-facing facts —
every platform package has a binary, every manifest says `access: public` —
rather than asserting the commands work.

## Still to do

**Trusted publishers are not configured.** Until each package has one at
`npmjs.com/package/<name>/access` (repository `ikrbasak/emquad`, workflow
`release.yml`), `release.yml` falls back to the token and logs a warning naming
which credential it used. That warning is the only signal that a package has not
been switched over — there is no other inventory.

**~~`packaging.test.js` still links the workspace copy by symlink.~~** Fixed. It
now `pnpm pack`s the binding and assembles a real `@emquad/typst-binding-<triple>`
package around the built `.node`, so the loader takes the same branch a published
install takes. The symlink was worse than merely approximate: it exercised the
loader's *dev fallback*, which is the one branch a published install never
reaches — so the test was green on a path no user has. Only `@emquad/fonts` is
still symlinked, and deliberately: it is scenery, not the thing under test.

What is still not covered is `os`/`cpu`/`libc` selection *among* the eight. The
test is offline and assembles the one package matching the host, so gating
remains proven on `darwin-arm64` alone.

## Deleting `spike/`

Phase 0's throwaway probes are gone. `spike/README.md` carried a table pinning
each probe to the phase that could delete it, and every row's condition is now
met — `soak.rs` → `benches/soak.rs`, `tagged.rs` → `untagged_output_is_smaller`,
`svgtext.rs` → hard rule 8 plus the rule 12 goldens, `interner.rs` →
`__panicInPool`, `runaway.rs` → the runaway-kill test in `process-pool.test.js`,
`pool.rs` + `procsweep.sh` → `bench/poolcmp.sh`.

The last row, `xtarget/`, was the one worth checking rather than assuming. Two
handoffs describe `sweep2.sh` as "the working environment for the other eleven"
targets, which reads like the only copy of something load-bearing. It is not:
[`../discovery/08-phase-0-results.md`](../discovery/08-phase-0-results.md#q5--psmstacker-across-the-target-matrix)
already records the recipe as a table — `CC=clang -target <triple>`, plus
`AR=ar` for the two Android triples — with the reasoning for why plain clang
suffices when `psm` only needs to *assemble*. The script produced that table; it
was never the record of it.

In the event the matrix needed less than either document implies. Of the eight
shipping targets only `aarch64-unknown-linux-musl` sets `CC_*`/`CXX_*` by hand,
and `aarch64-unknown-linux-gnu` gets the equivalent from `--use-napi-cross`. The
six triples the sweep covered that we do not ship — freebsd, two android, wasm32,
`win32-ia32`, `linux-arm-gnueabihf` — are why the script looked bigger than the
need.

The deleted files remain reachable in git history at `44c4eea` and earlier.

## Releasing after the bootstrap

Cutting `0.0.2` exposed two things the `0.0.1` bootstrap had hidden, because
`scripts/initial-publish.sh` did them by hand and no ongoing path ever had to.

**`napi version` does not update the loader's `optionalDependencies`.** It bumps
every `packages/binding/npm/*/package.json` to match the parent and stops. So
`pnpm changeset:version` produced platform packages at `0.0.2` and a loader still
pinned to `0.0.1`. Publishing that ships a new loader that resolves the
*previous* release's binaries — it installs, loads, and compiles, with stale
native code, drifting one release further every time. Nothing downstream would
notice.

Fixed by `scripts/sync-binding-optional-deps.mjs`, which runs **inside the
release workflow**, after the platform packages are published and before the
loader follows them. It pins
exact versions, not ranges: the loader and its binary come from one source tree
in one CI run, and a caret would let npm pair a loader with a binary it was never
tested against.

**And the fix cannot be committed, which took a red CI run to learn.** Bumping
those eight entries to `0.0.2` in the tree breaks `pnpm install --frozen-lockfile`
everywhere:

```
[ERR_PNPM_OUTDATED_LOCKFILE] pnpm-lock.yaml is not up to date with packages/binding/package.json
```

Refreshing the lockfile looks like it fixes it and does not. pnpm **silently
drops** all eight entries — nothing serves `0.0.2` yet — so the lockfile goes
from recording them at `0.0.1` to recording nothing, and `--frozen-lockfile`
passes **locally**. It then fails on every CI job, because that decision is
cached under `node_modules` and a clean checkout re-derives it. This is the same
shape as the `allowBuilds` failure that opened Phase 4: *a local pass is not
evidence when the state that makes it pass is not committed.*

So the rule is: **the committed `optionalDependencies` always name the previous
release.** They are rewritten during publish, in the window between the platform
packages going out and the loader following them — the first moment the new
version is a specifier anything can resolve.

Two consequences worth carrying:

- **The tree is never self-consistent about this**, by design. A `0.0.2` loader
  sits next to `optionalDependencies` naming `0.0.1` until the release runs.
  That looks like a bug and is not; the preflight says so explicitly.
- **CI never installs a real platform package.** It falls back to the `.node`
  built beside the loader, which is the development path. Do not read green CI
  as evidence that the published artifact resolves — only a registry install
  proves that.

The ordering constraint underneath is the one that forced a laptop script for
`0.0.1`: **the platform packages must exist in the registry before anything can
depend on them.**

**The workflow had kept the all-or-nothing publish the bootstrap threw away.**
`scripts/initial-publish.sh` was rewritten mid-bootstrap to publish the eight
platform packages individually, skipping any already on the registry, because
`napi pre-publish` shells out to `npm publish` for all of them and npm refuses
to republish an existing version — a run that dies partway can never be
restarted. `release.yml` still called `napi pre-publish`, where the consequence
is worse: the OIDC step and the token fallback ran the *same* command, so a
partial OIDC publish would make the fallback fail on the first already-published
package and strand the release with no way out but a version bump.

Now both paths call `scripts/publish-platform-packages.sh`, which is resumable
the same way. Replacing napi's command means the two things it did on the way
past have to be explicit: `napi artifacts` moves each binary into its
`npm/<platform>/` directory beforehand — without it every platform package
publishes with no `.node`, which installs cleanly and throws at require time on
that platform only — and `sync-binding-optional-deps.mjs` rewrites the loader's
`optionalDependencies` afterwards.

## Verified from the registry

A clean `npm install @emquad/core @emquad/fonts` into an empty project, with no
workspace and nothing built locally, installs **four** packages: core, fonts,
the loader, and exactly one platform binding — `os`/`cpu` gating picks the
matching one and skips the other seven. The installed `.node` is 29.7 MB, which
matches the measured figure.

From there it compiles: typst 0.15.1, one page, 8537 bytes, zero warnings, and
an embedded font subset — that last check matters more than the page count,
because a PDF with every text run silently dropped is still a valid PDF with the
right page count. The process pool also runs, which is the only way to prove
`dist/worker.js` survived packing and still resolves relative to the bundle in
an installed layout.

So the distribution mechanism works. What is *not* covered: this exercised
`darwin-arm64` only. The other seven platform packages are published and
correctly gated, but none has been installed on its own platform.
