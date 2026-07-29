# Build and Distribution

## Package naming

| Package | Purpose |
|---|---|
| `@emquad/core` | Main package: TS API + native loader |
| `@emquad/fonts` | Optional default Typst fonts (~9.3 MB) |
| `@emquad/resolver` | `@preview` registry resolver (TS, handles network) |
| `@emquad/typst-binding-<platform>` | Prebuilt native bindings, one per target |

### On the platform package names

The platform suffix **must** be napi's full platform identifier, including the ABI/libc
component: `linux-x64-gnu` vs `linux-x64-musl`, `win32-x64-msvc`, `linux-arm-gnueabihf`.

An earlier proposal used a bare `<os>-<arch>`. That does not work: without the third segment
**you cannot ship both glibc and musl builds**, and musl (Alpine) is a large share of Node
Docker images. Dropping it would directly undercut the wide-coverage goal.

So: `@emquad/typst-binding-darwin-arm64`, `@emquad/typst-binding-linux-x64-musl`,
`@emquad/typst-binding-win32-x64-msvc`, and so on.

**Configuring napi for this prefix.** `@napi-rs/cli` derives platform package names from
`napi.packageName` plus the target triple, and the generated loader resolves them by that
name. Since our binding prefix (`@emquad/typst-binding`) differs from the main package
(`@emquad/core`), set it explicitly:

```json
{ "napi": { "packageName": "@emquad/typst-binding" } }
```

With that set, the generator produces the right names and the loader stays in sync — no
hand-maintained resolution code.

### Naming collision to avoid

`@emquad/core` (the npm package) and a Rust crate named `emquad-core` would be two different
things called "core" — the public TS API versus an internal Rust library. The Rust crate is
therefore named **`emquad-engine`**.

### Discoverability note

`@emquad/core` says nothing about what the package does, and nobody searches npm for "core".
Compensate with `keywords` (`typst`, `pdf`, `pdf-generation`, `puppeteer-alternative`) and a
description that leads with the function, not the brand.

## Distribution mechanism

**napi-rs prebuilds via `optionalDependencies`. No postinstall download.**

Each platform package declares `os`, `cpu`, and (where relevant) `libc`, so package managers
skip incompatible ones automatically. The main package's generated loader picks the matching
one at require time.

This means no network at install time beyond the registry itself, works behind corporate
proxies, and is compatible with `pnpm`'s strict install model and offline caches.

## Target matrix

Wide native coverage plus a universal fallback:

| Platform | Targets |
|---|---|
| macOS | `darwin-x64`, `darwin-arm64` |
| Linux (glibc) | `linux-x64-gnu`, `linux-arm64-gnu`, `linux-arm-gnueabihf` |
| Linux (musl) | `linux-x64-musl`, `linux-arm64-musl` |
| Windows | `win32-x64-msvc`, `win32-arm64-msvc`, `win32-ia32-msvc` |
| FreeBSD | `freebsd-x64` |
| Android | `android-arm64`, `android-arm-eabi` |
| **Fallback** | `wasm32-wasip1-threads` |

Built with `napi build --use-napi-cross` (glibc 2.17 baseline).

### The `wasm32-wasip1-threads` fallback is not equivalent

It guarantees `pnpm add` never hard-fails on an unlisted platform, which is valuable. But
**the stack cannot grow on wasm**, so deeply-nested documents may overflow where they would
succeed natively. Document this explicitly rather than presenting the fallback as a drop-in
equivalent.

The mechanism, confirmed in Phase 0: typst gates the dependency out entirely —
`typst-eval-0.15.1/Cargo.toml:80` declares stacker under
`[target.'cfg(not(target_arch = "wasm32"))'.dependencies]`, and the call site comment reads
*"Stacker is broken on WASM."* So the evaluator simply recurses on the default stack.
`MAX_DEPTH` still applies, which bounds how deep it can get.

### `psm`/`stacker` — verified in Phase 0, all 14 targets viable

It is the only dependency with per-architecture assembly (pulled in by `typst-eval` for the
recursive evaluator). Everything else is pure Rust — 284 crates, zero `-sys` crates, no
OpenSSL, bindgen, or cmake.

`psm` ships assembly for every architecture in this matrix, and `cargo check` passes for all 14
triples. Full results in
[08-phase-0-results.md](08-phase-0-results.md#q5--psmstacker-across-the-target-matrix).

**⚠ The three `win32-*-msvc` targets cannot be cross-compiled.** `stacker` compiles
`src/arch/windows.c`, which `#include`s `windows.h`, and `psm` needs MSVC's `lib.exe`. Both
require the real Windows SDK, so **those packages must build on a native Windows runner**. Plans
to produce the whole matrix from one Linux container will not work.

This also qualifies the "no C toolchain" property above: it holds everywhere except Windows.

Everything else cross-compiles with just `clang -target <triple>` (plus `AR=ar` for Android),
which is what `--use-napi-cross` supplies in CI. The earlier assumption that this was the most
likely thing to break the matrix did not hold up — it was the easy part.

Protecting the zero-`-sys` property is why the `@preview` network layer lives in TypeScript
(see [04-packages-and-network.md](04-packages-and-network.md)). Any PR adding a native
dependency with a build script deserves scrutiny.

## Binary size

Fonts ship separately, so each platform package is **29.4 MB uncompressed / 12.8 MB gzipped**,
and users download exactly one. Since npm distributes gzipped tarballs, **~12.8 MB is the real
per-user download.**

For reference, official `typst-cli` 0.15.1 (darwin-arm64) is **45.0 MB uncompressed** — on an
identical basis (fonts embedded) our build is 39.2 MB, or **~13% smaller than upstream**.

> Do not compare against the sub-20 MB assets on the typst releases page. Those are
> xz-compressed *archives*, not binaries.

Release profile: `lto = true`, `codegen-units = 1`, `strip = true`, `opt-level = 3`.
**Do not use `panic = "abort"`** — it disables `catch_unwind`, which hard rule 2 depends on.

Full measurements and the size-lever assessment are in
[07-benchmarks.md](07-benchmarks.md#binary-size).

## Monorepo tooling

**pnpm workspaces + turbo.**

```
emquad/
├─ Cargo.toml                 # rust workspace
├─ crates/
│  ├─ emquad-engine/          # pure Rust: VFS, World, fonts, diagnostics (no napi)
│  └─ emquad-napi/            # thin napi-rs binding layer
├─ packages/
│  ├─ core/                   # @emquad/core
│  ├─ fonts/                  # @emquad/fonts
│  └─ resolver/               # @emquad/resolver
└─ npm/<platform>/            # generated @emquad/typst-binding-<platform> packages
```

Keeping `emquad-engine` free of napi matters: it stays testable with plain `cargo test`, and it
is what allows a wasm or CLI target later without restructuring.
