# emquad

A lean Node.js binding for [Typst](https://github.com/typst/typst) that does one job well:
**virtual filesystem in → PDF out.** Built as a fast, light replacement for Chromium +
Puppeteer PDF pipelines.

> **Status: work in progress. Nothing is published yet.**
> The Rust core (`crates/emquad-engine`) compiles a VFS to a PDF and is tested. The Node
> bindings, the TypeScript API, and the published packages do not exist yet.

## Layout

| Path | What it is |
|---|---|
| `crates/emquad-engine/` | The Typst compilation core. Pure Rust, no napi dependency. **Done.** |
| `scripts/` | Dependency guard and benchmark comparison harness |
| `spike/` | Phase 0 throwaway probes, kept for the parts not yet promoted |
| `.claude/` | Plan, research, and phase documentation |

## Getting oriented

Everything is documented under [`.claude/`](.claude/CLAUDE.md):

- [`.claude/PLAN.md`](.claude/PLAN.md) — the phased implementation plan
- [`.claude/discovery/`](.claude/discovery/00-overview.md) — research and measurements behind
  the design
- [`.claude/phase-1/`](.claude/phase-1/00-overview.md) — what the Rust core is and how it works
- [`LICENSING.md`](LICENSING.md) — what ships, under what terms, and what would break it

## Building

```sh
cargo test                  # 61 tests
cargo bench --bench compile # throughput
pnpm install                # dev tooling + git hooks
pnpm lint                   # oxlint + clippy
```

The first Rust build takes several minutes: 293 crates, and the release profile uses
`lto = true` with `codegen-units = 1`.

## License

MIT — see [LICENSE](LICENSE).

The shipped native binary statically links ~290 Rust crates, Typst among them, which is
Apache-2.0. Their attribution is in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), generated
rather than hand-maintained. The default fonts are a separate optional package under four
further licenses — see [LICENSING.md](LICENSING.md).
