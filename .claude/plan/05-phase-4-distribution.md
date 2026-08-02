# Phase 4 — Build and Distribution

Full detail in [`../discovery/06-distribution.md`](../discovery/06-distribution.md).

## 4.1 Pull this forward

**Verify `psm`/`stacker` builds on every exotic target during Phase 0 or 1**, not here.

It is the only dependency with per-architecture assembly, and therefore the most likely thing
to break the matrix. Discovering a dead target after the release pipeline is built means
rework. Cross-compile a trivial `typst-eval`-dependent binary against the full target list
early, and drop anything that fails before investing in tooling.

## 4.2 napi configuration

```json
{ "napi": { "packageName": "@emquad/typst-binding" } }
```

Required because the binding prefix differs from the main package name (`@emquad/core`).
With it set, `@napi-rs/cli` generates correctly-named platform packages and a matching loader.

Build with `napi build --release --platform --esm` — `--esm` emits a real ESM wrapper instead
of CJS, and only takes effect alongside `--platform`.

Cross-compilation uses `--use-napi-cross` (glibc 2.17 baseline).

## 4.3 Target matrix

| Platform | Targets |
|---|---|
| macOS | `darwin-x64`, `darwin-arm64` |
| Linux (glibc) | `linux-x64-gnu`, `linux-arm64-gnu`, `linux-arm-gnueabihf` |
| Linux (musl) | `linux-x64-musl`, `linux-arm64-musl` |
| Windows | `win32-x64-msvc`, `win32-arm64-msvc`, `win32-ia32-msvc` |
| FreeBSD | `freebsd-x64` |
| Android | `android-arm64`, `android-arm-eabi` |
| Fallback | `wasm32-wasip1-threads` |

Each platform package declares `os`, `cpu`, and `libc` so package managers skip incompatible
ones. All are listed in the main package's `optionalDependencies`. **No postinstall download.**

The musl targets are not optional — Alpine is a large share of Node Docker images, and this is
precisely why the platform suffix must carry the libc component.

## 4.4 Release profile

```toml
[profile.release]
lto = true
codegen-units = 1
strip = true
opt-level = 3
```

~28 MB per platform package (fonts ship separately). Users download exactly one.

## 4.5 Guard the dependency tree

The zero-`-sys`-crate property is what makes this matrix affordable. Add a CI check that fails
if a new `-sys` crate, `cmake`, `bindgen`, or OpenSSL dependency enters the tree. This is
cheap insurance against a well-meaning PR quietly making six targets unbuildable.

## 4.6 Release pipeline

- Build all targets, run packaging tests per
  [07-testing-strategy.md](07-testing-strategy.md#7-packaging-tests).
- Publish platform packages **before** the main package, so `optionalDependencies` resolve on
  first install.
- npm provenance attestation.
- Changesets (or equivalent) for versioning across the pnpm workspace.

## 4.7 Version policy

Typst is pre-1.0 and breaks on minor releases (see
[`../discovery/01-typst-as-a-library.md`](../discovery/01-typst-as-a-library.md)).

- Pin exact typst versions (`=0.15.1`).
- A typst minor bump is a **minor bump of our package**, with the change noted in the changelog.
- Document the typst version in the README and expose it at runtime, so users can correlate
  rendering differences with a version.

## Deliverables

- Green CI across the full matrix
- Platform packages published and resolving correctly
- Dependency-tree guard in CI (`scripts/check-no-sys-crates.sh`, already written)
- License gate in CI: `cargo deny check licenses` plus a check that
  `THIRD-PARTY-NOTICES.md` is current — see [`../../LICENSING.md`](../../LICENSING.md)
- Byte-identity test on the fonts shipped by `@emquad/fonts`; subsetting them would
  relicense that package as GPL-3 (hard rule 11)
- ~~Documented typst-version compatibility policy~~ **Done** — README "Typst versions". The
  runtime half was already there (`typstVersion()` is exported from `@emquad/core`); what was
  missing was saying so anywhere a user would look, and stating that the pin is *static* —
  there is no way to pair a given emquad with a different typst, because the compiler is inside
  the binary rather than resolved at install time.
- ~~Fold `spike/xtarget/sweep2.sh`'s `CC`/`CFLAGS`/`AR` environment into the matrix, then
  delete `spike/`.~~ **Done.** The matrix needed less of it than expected — eight shipping
  targets, of which only `aarch64-unknown-linux-musl` needs the explicit `CC_*`/`CXX_*` pair,
  and `aarch64-unknown-linux-gnu` gets the equivalent from `--use-napi-cross`. See
  [`../phase-4/00-publishing.md`](../phase-4/00-publishing.md#deleting-spike).
