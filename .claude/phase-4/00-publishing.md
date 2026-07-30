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

**`packaging.test.js` still links the workspace copy by symlink.** The platform
packages now exist, so it can become a true clean-room install from the registry
— which is the only thing that would prove the published artifact works, as
opposed to the working tree working.

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
