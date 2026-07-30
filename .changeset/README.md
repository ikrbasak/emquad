# Changesets

Versioning for the npm workspace. `pnpm changeset` to describe a change,
`pnpm changeset:version` to apply the pending ones.

Nothing here touches crates.io — both Rust crates are `publish = false`. npm is
the only distribution channel.

## Why the config looks like this

**`fixed: [["@emquad/core", "@emquad/typst-binding"]]`.** These two must carry
the same version. `@emquad/core` depends on the binding as `workspace:*`, which
pnpm rewrites to the exact version at publish time, and the pair is meaningless
split — the loader and the API it fronts are one artifact wearing two names.

`@emquad/fonts` and `@emquad/resolver` are deliberately not in that group. Both
are independently useful and neither is coupled to a typst version bump.

**`privatePackages: { version: true, tag: false }`.** `@emquad/typst-binding`
is still `private`, which changesets would otherwise read as "never version
this". It needs a version now — the platform packages are stamped from it — and
it will publish on its own once `private` comes off. `tag: false` keeps it from
minting a second git tag for what is really one release.

**`access: "public"`.** Scoped packages default to `restricted`, and a first
publish under that default quietly produces a private package rather than an
error.

## What changesets does *not* version

The eight `@emquad/typst-binding-<platform>` packages under
`packages/binding/npm/` are not workspace members — `pnpm-workspace.yaml` globs
`packages/*`, which does not reach them. They are stamped by `napi version` from
`packages/binding/package.json`, and `napi pre-publish` copies each `.node` into
place. Do not hand-edit their versions; run the napi commands.

So a release is two mechanisms, in this order:

1. `changeset version` sets the workspace versions and writes changelogs.
2. `napi version` propagates the binding's new version to the platform packages.

## Not usable yet

`@emquad/typst-binding` is `private` and declares no `optionalDependencies`, so
`release.yml`'s preflight fails on purpose and names both. The ordering
constraint behind that is real and worth knowing before trying to shortcut it:
pnpm silently drops an optional dependency it cannot resolve and never writes it
to the lockfile, so declaring the platform packages before they exist in a
registry makes `pnpm install --frozen-lockfile` fail in every CI job,
permanently. Publish the platform packages first, then declare them.

## Version policy

Typst is pre-1.0 and breaks across minor releases, so it is pinned exactly
(`=0.15.1`, hard rule 5). **A typst minor bump is a minor bump of our packages**,
called out in the changelog, because it can change rendering output for a
document nobody edited. Patch releases never move typst.
