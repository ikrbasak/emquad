# emquad

A lean Node.js binding for [Typst](https://github.com/typst/typst) that does one job well:
**virtual filesystem in → PDF out.** Built as a fast, light replacement for Chromium +
Puppeteer PDF pipelines.

> **Status: work in progress. Nothing is published yet.**
> The Rust core, the Node bindings, and the TypeScript packages are all built and tested.
> What remains is distribution: prebuilt per-platform binaries and CI across the target matrix.

```ts
import { Compiler } from "@emquad/core";
import { defaultFonts } from "@emquad/fonts";

const compiler = new Compiler({ fonts: defaultFonts });

const { pdf, warnings } = await compiler
  .document()
  .source('#let d = json("/data.json")\n= Invoice #d.number')
  .data({ number: "INV-1024" })
  .compile({ tagged: false });
```

## Layout

| Path | What it is |
|---|---|
| `crates/emquad-engine/` | The Typst compilation core. Pure Rust, no napi dependency. **Done** |
| `crates/emquad-napi/` | Node bindings: thread pool, cache lifecycle, JS boundary. **Done** |
| `packages/core/` | `@emquad/core` — the public API, both pools, `EmquadError`. **Done** |
| `packages/resolver/` | `@emquad/resolver` — `@preview` packages. Zero runtime deps. **Done** |
| `packages/fonts/` | `@emquad/fonts` — 17 default faces, four licenses. **Done** |
| `packages/binding/` | The built addon and its generated bindings. Internal, not published |
| `scripts/` | Dependency guard and benchmark comparison harness |
| `.claude/` | Plan, research, and phase documentation |

## Getting oriented

Everything is documented under [`.claude/`](.claude/CLAUDE.md):

- [`.claude/PLAN.md`](.claude/PLAN.md) — the phased implementation plan
- [`.claude/discovery/`](.claude/discovery/00-overview.md) — research and measurements behind
  the design
- [`.claude/phase-1/`](.claude/phase-1/00-overview.md) — what the Rust core is and how it works
- [`.claude/phase-2/`](.claude/phase-2/00-overview.md) — the Node bindings and the thread pool
- [`.claude/phase-3/`](.claude/phase-3/00-overview.md) — the TypeScript packages, the
  worker-process pool, and the API guide
- [`LICENSING.md`](LICENSING.md) — what ships, under what terms, and what would break it

## Building

```sh
pnpm install          # dev tooling + git hooks
pnpm build            # turbo: the native addon, then every package
pnpm test             # 64 Rust tests + 115 Node tests
pnpm typecheck        # tsc --noEmit across the workspace
pnpm lint             # oxlint + clippy
pnpm fmt              # oxfmt + rustfmt
```

Requires Node ≥ 22.

The first build takes several minutes: 293 crates, and the release profile uses `lto = true`
with `codegen-units = 1`. Turbo caches the result, so later runs skip it.

## Two things worth knowing

**Paths are canonical; content is what varies.** Typst interns every distinct virtual path in a
process-global table that is never freed and is capped at 65,535. `.asset("/logo.png", bytes)`
with different bytes per request is correct; `.asset(\`/logo-${id}.png\`, bytes)` leaks
permanently and aborts the process at around 65k renders.

**Choose the pool by document shape, not by taste.** The default in-process thread pool is up to
1.5× faster on ordinary documents. On documents that repeatedly re-configure the page, it gets
*slower* as threads are added — and `pool: { mode: "process" }` is 6.9× faster. Process mode is
also the only way to survive an untrusted template, since typst has no cancellation hook.
Measurements in [`.claude/phase-3/03-findings.md`](.claude/phase-3/03-findings.md).

## License

MIT — see [LICENSE](LICENSE).

The shipped native binary statically links ~290 Rust crates, Typst among them, which is
Apache-2.0. Their attribution is in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), generated
rather than hand-maintained. `@emquad/fonts` is a separate optional package under four further
licenses, one of them GPL-3.0-or-later — see [LICENSING.md](LICENSING.md).
