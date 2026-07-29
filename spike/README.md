# Phase 0 spike — throwaway probes

This is **not** production code and is not part of the build. It is the harness that produced
[`.claude/discovery/08-phase-0-results.md`](../.claude/discovery/08-phase-0-results.md), kept so
the numbers stay reproducible.

Neither crate is a member of the workspace. Build each on its own.

## TODO: delete this directory

It is scheduled for removal, in two steps. Track it here rather than trusting anyone to
remember.

| Probe | Status | Deleted when |
|---|---|---|
| `phase0/src/bin/soak.rs` | **Superseded** by `crates/emquad-engine/benches/soak.rs` | now redundant — remove with the rest |
| `phase0/src/bin/tagged.rs` | **Superseded** — covered by `untagged_output_is_smaller` and the `PdfSettings` tests | now redundant |
| `phase0/src/bin/svgtext.rs` | **Superseded** — the finding is hard rule 8, enforced by `FontRegistryBuilder::build` | now redundant |
| `phase0/src/bin/interner.rs` | Still the only probe that reaches typst's real 65,535 cap; `tests/interner_guard.rs` deliberately stops at *our* guard | Phase 2, once the napi layer proves `catch_unwind` holds |
| `phase0/src/bin/runaway.rs` | Still the only harness for runaway compiles, pool wedging, and kill cost | **Phase 2** — promote into the worker-process pool's tests |
| `phase0/src/bin/pool.rs` + `procsweep.sh` | Still the only thread-vs-process scaling comparison, which is the evidence behind the process pool | **Phase 2** |
| `xtarget/` | Still the only record of the `CC`/`CFLAGS`/`AR` environment that got 13 of 14 targets cross-compiling | **Phase 4** — fold into the CI matrix |

Once Phase 4 has a green matrix and Phase 2 has its own process-pool tests, delete
`spike/` entirely.

## `phase0/` — measurement probes

```
cargo build --release                          # ~15 min: LTO + codegen-units=1
./target/release/interner 70000                # FileId interner cap and leak cost
./target/release/soak 100000 evict:16          # RSS over a long run; none | evict:N
./target/release/pool 400 16                   # throughput vs thread-pool size
./procsweep.sh 400                             # same, but across processes (contention control)
./target/release/tagged                        # PdfOptions.tagged time and size cost
./target/release/svgtext                       # missing-font behavior
./target/release/runaway supervise membomb     # runaway compiles: loop|membomb|bigloop|slowloop|deepnest|deeprec
./target/release/runaway poolwedge             # blast radius of one wedged compile
./target/release/runaway killcost 60           # child-process-per-compile overhead
```

`PHASE0_DOC` selects the document under test: `invoice` (default, single page),
`report` (content-heavy, one page run), `multirun` (40 page runs — the shape where thread
scaling collapses).

## `xtarget/` — target-matrix verification

```
./sweep.sh     # cargo check for all 14 triples, bare host
./sweep2.sh    # same, with clang as a cross-assembler for psm
```

`sweep2.sh` is the meaningful one; `sweep.sh` is kept because its failures document *why* a bare
macOS host cannot build the matrix.

## Two traps these probes hit — do not repeat them

1. **A probe that never calls `typst::compile` measures nothing.** With `lto = true` the linker
   dead-strips the entire compile and PDF pipeline, which once produced a "376 KB" binary-size
   figure for a full typesetting engine.
2. **Benchmarks that vary one option must use disjoint document ranges per configuration.**
   Otherwise whichever config runs second harvests `comemo` hits from the first. This produced a
   wrong `tagged` result (+139% time) before it was caught; the real figure is +5%.
