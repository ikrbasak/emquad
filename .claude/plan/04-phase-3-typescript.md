# Phase 3 — TypeScript Layer

Two packages: `@emquad/core` (public API) and `@emquad/resolver` (`@preview` package
resolution). The resolver touches no Rust and can be built in parallel with Phases 1–2.

## Build requirements

**Full TypeScript, ESM-only.**

- `"type": "module"`, `exports` map with `types` first.
- Target modern Node (≥20). No CJS build, no dual-package hazard.
- Declaration files generated from source, not hand-written.
- `strict: true`, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

### The native-addon/ESM wrinkle

Node's ESM loader **cannot `import` a `.node` file directly** — native addons load through
`process.dlopen`/`require`. This is the single most common way napi + ESM setups break.

napi-rs handles it: build with `napi build --platform --esm` to emit a real ESM wrapper
rather than a CJS `index.js`. Do not hand-roll `createRequire` unless the generator proves
insufficient.

Verify in CI that the published package actually imports under `"type": "module"` — a
smoke test that `import { Compiler } from '@emquad/core'` works from a clean ESM consumer
project. This catches loader regressions that unit tests miss entirely.

## API shape

Long-lived `Compiler` (expensive: fonts, thread pool) plus a cheap per-document builder.
Rationale in [`../discovery/05-fonts-assets-charts.md`](../discovery/05-fonts-assets-charts.md).

```ts
import { Compiler } from '@emquad/core';
import { defaultFonts } from '@emquad/fonts';

const compiler = new Compiler({
  fonts: [...defaultFonts, myBrandFont],   // parsed ONCE
  assets: { 'assets/logo.png': logoBuf },  // shared base layer
  pool: { size: 8 },
  cache: { maxAge: 2 },                    // eviction on by default
});

const pdf = await compiler.document()
  .source('main.typ', template)            // canonical path
  .asset('assets/logo.png', tenantLogo)    // overrides base layer
  .data({ invoice })                       // injected as Typst values
  .compile({ tagged: false });
```

`compiler.documentSync()` mirrors this for batch use.

### API rules derived from the footguns

**Paths are canonical, content varies.** Do not accept caller-generated filenames. This is
enforcement of [footgun #1](../discovery/02-footguns.md#1-fileid-is-a-leaky-capped-process-global-interner) —
per-request unique paths leak `FileId`s permanently and hard-panic the process at ~65k renders.
Make the safe form the only ergonomic one; if an escape hatch for dynamic paths is ever added,
it must be explicitly named and loudly documented.

**No `timeout` option.** See [Phase 2](03-phase-2-napi.md#24-explicitly-not-implemented).

**Errors are structured.** A `TypstError` subclass exposing `file`, `line`, `column`,
`severity`, and `hints` as real fields — not a formatted string. Warnings are returned
alongside successful output, not discarded.

## `@emquad/resolver`

Implements the design in
[`../discovery/04-packages-and-network.md`](../discovery/04-packages-and-network.md).

- Fetch `https://packages.typst.org/preview/{name}-{version}.tar.gz`, gunzip (`node:zlib`),
  untar, mount into the base VFS layer.
- Three-tier cache: memory → disk (`~/.cache/typst/packages/…`, shared with `typst-cli`) →
  network. **Never fetch per compile.**
- Resolution modes: `auto`, `offline`, `vendor`.
- Compile–fetch–retry loop seeded by a regex prescan, to handle transitive dependencies under
  the synchronous `World::file` constraint.
- `typst.lock.json` with integrity hashes; verify on every disk-cache read, not just download.
- Respect `HTTPS_PROXY`; allow a configurable registry base URL for mirrors.

## `@emquad/fonts`

Plain data package — the Typst default fonts (~9.3 MB) plus their license texts.

**The fonts are not all OFL, and they are not Apache-2.0 like Typst itself.** The 17 files span
four licenses, one of them GPL-3.0-or-later. Shipping them verbatim is fine; **subsetting
`NewCM10-Regular.otf` to save space would relicense this package as GPL-3.** Read
[`../../LICENSING.md`](../../LICENSING.md) before touching it — the breakdown, the exception
text it depends on, and the required packaging test are all there.

## Deliverables

- ESM-only, fully typed `@emquad/core` with `Compiler` + document builder
- `@emquad/resolver` with disk cache, lockfile, and offline mode
- `@emquad/fonts` with licenses
- Clean-consumer ESM import smoke test in CI
- Typed API surface tested per [07-testing-strategy.md](07-testing-strategy.md)
