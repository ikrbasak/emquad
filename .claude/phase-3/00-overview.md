# Phase 3 — TypeScript Layer. Complete.

Three published packages and the worker-process pool. `@emquad/core` is what users import;
`@emquad/resolver` owns all networking; `@emquad/fonts` is data plus four licenses.

**Status: complete.** 64 Rust tests and 115 Node tests pass; clippy, rustfmt, oxlint, oxfmt, and
`tsc` are clean. Phase 4 (distribution) is not started.

Brief: [`../plan/04-phase-3-typescript.md`](../plan/04-phase-3-typescript.md). Everything in it
is delivered, including the worker-process pool that moved here from Phase 2.

## Read these in order

| Document | What it answers |
|---|---|
| [`01-architecture.md`](01-architecture.md) | How the packages fit together, and the pool in detail |
| [`02-api-guide.md`](02-api-guide.md) | The public API, with working examples |
| [`03-findings.md`](03-findings.md) | **What Phase 3 measured, and two new silent-failure modes** |
| [`04-tooling.md`](04-tooling.md) | The JS/TS toolchain: tsdown, TypeScript 7, turbo, `#/` imports |
| [`05-handoff.md`](05-handoff.md) | **Start here if you are picking up Phase 4** |

Phases [1](../phase-1/00-overview.md) and [2](../phase-2/00-overview.md) still describe the Rust
layers underneath, and their findings are still current.

## What runs

```sh
pnpm build                                  # turbo: every package
pnpm typecheck                              # tsc --noEmit, every package
pnpm test                                   # cargo test + turbo run test
pnpm lint && pnpm fmt:check

# Individually
pnpm --filter @emquad/core test             # 44 tests, including golden renders
pnpm --filter @emquad/resolver test         # 29, one skipped (network)
pnpm --filter @emquad/fonts test            # 10, the licensing guard

UPDATE_GOLDENS=1 pnpm --filter @emquad/core exec node --test "test/golden.test.js"
EMQUAD_NETWORK_TESTS=1 pnpm --filter @emquad/resolver test
./packages/core/bench/poolcmp.sh multirun   # thread vs process, one config per process
```

`pnpm test` needs the native addon. Turbo builds it first, and caches it after — the first run
pays several minutes of LTO link, later runs pay nothing.

## The shape of it

```
packages/core/
  src/
    index.ts           public surface
    binding.ts         the ONE import of @emquad/binding — Phase 4 edits this file
    compiler.ts        Compiler: validates options, picks a backend
    document.ts        the fluent per-document builder
    errors.ts          EmquadError, diagnostics, code normalization
    types.ts           public option types
    convert.ts         public types <-> binding types; font descriptor reading
    backend.ts         the interface both pools implement
    thread-backend.ts  the Rust thread pool (default)
    pool/
      process-pool.ts  the worker-process pool: supervision, timeout, backpressure
      worker.ts        the child entry point — a second bundle entry
      protocol.ts      the IPC message types
  test/
    core.test.js       21 — API, errors, reproducibility, concurrency
    process-pool.test.js  12 — isolation, kill-and-recover, backpressure
    golden.test.js     8 — rendered-page comparisons
    packaging.test.js  3 — packs the tarball and imports it as a consumer
    golden/            fixtures, generated assets, committed reference renders
  bench/               pool.js, poolcmp.sh

packages/resolver/
  src/
    resolver.ts        three-tier cache, modes, transitive resolution
    registry/…         spec.ts, tar.ts, cache.ts, lockfile.ts, integrity.ts, errors.ts
  test/                registry.js (in-memory registry + tar writer), 29 tests

packages/fonts/
  fonts/               17 files, 9.3 MB, byte-for-byte
  licenses/NOTICE      all four license texts, verbatim from typst-assets
  src/manifest.ts      GENERATED: filename, license, size, sha256
  scripts/sync.mjs     regenerates the above from the vendored crate
```

## Two things worth knowing before reading the code

### `pool.timeoutMs` exists, and hard rule 3 still holds

Rule 3 forbids a `timeout` option on the compile API, because typst has no cancellation hook and
a Rust thread cannot be killed — a timeout there would report failure while the thread stayed
wedged forever. That reasoning is intact and the option does not exist on `compile()`.

`pool.timeoutMs` is a different thing: it is a property of the **process** pool, and it works by
killing the worker. The rule's own text says untrusted templates require process isolation, and
this is that. Setting it without `pool.mode: "process"` is a construction error rather than a
no-op, so the option cannot be mistaken for protection it is not providing.

### A failed compile throws here, unlike in the binding

`@emquad/binding` *returns* `{ ok: false, error }` because a rejected promise can only carry a
`napi::Error`. `@emquad/core` converts that into a thrown `EmquadError` with `code`, `file`,
`line`, `column`, `diagnostics`, and `hints` as real fields. That conversion is the reason this
layer exists at all — a JS `Error` subclass cannot be constructed from Rust.
