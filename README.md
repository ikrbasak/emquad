# emquad

A lean Node.js binding for [Typst](https://github.com/typst/typst) that does one job well:
**virtual filesystem in → PDF out.** Built as a fast, light replacement for Chromium +
Puppeteer PDF pipelines.

> **Status: work in progress. Nothing is published yet.**
> The Rust core compiles a VFS to a PDF and the Node bindings expose it, with a dedicated
> compile thread pool. The TypeScript API, the package resolver, and the published packages do
> not exist yet.

## Layout

| Path | What it is |
|---|---|
| `crates/emquad-engine/` | The Typst compilation core. Pure Rust, no napi dependency. **Done.** |
| `crates/emquad-napi/` | Node bindings: thread pool, cache lifecycle, JS boundary. **Done.** |
| `packages/binding/` | The built addon and its generated bindings. Internal, not published |
| `scripts/` | Dependency guard and benchmark comparison harness |
| `spike/` | Phase 0 throwaway probes, kept for the parts not yet promoted |
| `.claude/` | Plan, research, and phase documentation |

## Getting oriented

Everything is documented under [`.claude/`](.claude/CLAUDE.md):

- [`.claude/PLAN.md`](.claude/PLAN.md) — the phased implementation plan
- [`.claude/discovery/`](.claude/discovery/00-overview.md) — research and measurements behind
  the design
- [`.claude/phase-1/`](.claude/phase-1/00-overview.md) — what the Rust core is and how it works
- [`.claude/phase-2/`](.claude/phase-2/00-overview.md) — the Node bindings and the thread pool
- [`LICENSING.md`](LICENSING.md) — what ships, under what terms, and what would break it

## Building

```sh
cargo test                                 # 64 Rust tests
pnpm install                               # dev tooling + git hooks
pnpm --filter @emquad/binding test         # builds the addon, then 32 Node tests
pnpm lint                                  # oxlint + clippy
cargo bench --bench compile                # engine throughput
```

Requires Node ≥ 22.

The first Rust build takes several minutes: 293 crates, and the release profile uses
`lto = true` with `codegen-units = 1`.

## License

MIT — see [LICENSE](LICENSE).

The shipped native binary statically links ~290 Rust crates, Typst among them, which is
Apache-2.0. Their attribution is in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), generated
rather than hand-maintained. The default fonts are a separate optional package under four
further licenses — see [LICENSING.md](LICENSING.md).
