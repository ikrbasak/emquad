# Typst Packages and Network Access

**Decision: network access is enabled, and implemented in the TypeScript layer — not in Rust.**

## Why not in Rust

Rust HTTPS means `rustls`, and `rustls` needs a crypto provider:

- `aws-lc-rs` — requires cmake and a C toolchain. Breaks musl, BSD, and exotic
  cross-compilation targets.
- `ring` — per-architecture hand-written assembly. A second `psm`-class hazard, on exactly the
  targets most likely to break.

Either choice destroys the **zero-`-sys`-crate** property documented in
[01-typst-as-a-library.md](01-typst-as-a-library.md), which is the single thing making the
wide os/arch matrix affordable. Trading that for functionality Node already provides natively
would be a bad deal.

Node ships `fetch`, TLS, and zlib in the box. So:

- **Rust core** keeps one pure contract: VFS in → PDF out. No network in the hot path,
  fully deterministic, trivially testable, no new dependencies.
- **`@emquad/resolver` (TS)** handles fetch, verify, cache, extract, and mount.

Extra benefits that would be painful to rebuild in Rust: lockfile pinning with integrity
hashes, `HTTPS_PROXY` support via undici, custom/mirror registries, and a real offline mode.

## Registry protocol (verified empirically)

```
GET https://packages.typst.org/preview/{name}-{version}.tar.gz
→ 200, content-type: application/gzip
→ cache-control: public, max-age=7776000   (90 days)
→ etag: "0x8DEED5509D1F916"

GET https://packages.typst.org/preview/index.json
→ 200, ~2.0 MB — full index of all published packages
```

Measured: `cetz-0.4.2.tar.gz` is **126 KB**. Packages are small.

Import syntax `@preview/{name}:{version}` maps to `VirtualRoot::Package(PackageSpec)`, which
plugs directly into the same VFS map — no separate code path needed.

## Caching: fetched once, ever — never per compile

**A published package version is immutable.** Combined with the 90-day `cache-control`, this
means cache-forever-keyed-by-version is correct, and no revalidation is needed.

Three tiers:

| Tier | Scope | Lifetime |
|---|---|---|
| **Memory** | Mounted into the `Compiler`'s base VFS layer | Process lifetime |
| **Disk** | `~/.cache/typst/packages/preview/{name}/{version}/` | Machine, indefinite |
| **Network** | Registry | Once per version, ever |

Use the same on-disk layout as `typst-cli` so the cache is **shared with any existing typst
installation** — many users will already have these packages on disk and hit zero network.

Because mounted packages live in the base layer (see
[05-fonts-assets-charts.md](05-fonts-assets-charts.md)), they are parsed once and reused
across every compile at zero marginal cost. They are also a **bounded set**, so they pose no
risk to the `FileId` interner.

Resolution modes:

- `auto` (default) — fetch on demand, cache to disk.
- `offline` — cache and vendored packages only; fail on miss. For hermetic CI.
- `vendor` — pre-download into the repo for fully air-gapped builds.

## The critical constraint: `World::file()` is synchronous

```rust
fn file(&self, id: FileId) -> FileResult<Bytes>;
```

It is called **synchronously, mid-layout**. You cannot perform an async network fetch inside
it. Therefore **all packages must be resolved and mounted before `compile()` is called.**

Getting this wrong is the main way "network support" ends up quietly not working.

### The resolution strategy

A **compile–fetch–retry loop**, seeded by a cheap prescan:

1. **Prescan** the source with a regex for `@preview/{name}:{version}` and prefetch those.
   Handles the common case in a single pass.
2. **Compile.** If it fails with a package-not-found diagnostic, fetch that package, mount it
   into the base layer, and retry.
3. **Repeat** until success or no new package appears. Bound the iterations.

Step 2 is what makes it robust: it handles **transitive dependencies** naturally (each pass
surfaces the next missing package) and catches dynamically-constructed imports the regex
misses. Step 1 keeps the common case fast.

After warm-up, the loop resolves on the first attempt every time, so steady-state cost is zero.

## Supply chain

Typst packages cannot perform I/O or execute arbitrary code, so the blast radius is confined
to rendering output. That said:

- Ship a **lockfile** (`typst.lock.json`) pinning `name@version` plus an integrity hash from
  day one. Retrofitting this after people depend on it is painful.
- Verify the hash on every disk-cache read, not only on download.
- Support a configurable registry base URL for mirrors and air-gapped environments.
