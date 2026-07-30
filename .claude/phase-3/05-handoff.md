# Handoff to Phase 4

Written for someone — human or agent — who has not seen the earlier work.

## Where things stand

Phases 0 through 3 are complete. Phase 4 (distribution) has not started. The brief is
[`../plan/05-phase-4-distribution.md`](../plan/05-phase-4-distribution.md).

| Layer | State |
|---|---|
| `crates/emquad-engine` | Done. VFS → PDF. [`../phase-1/`](../phase-1/00-overview.md) |
| `crates/emquad-napi` | Done. Thread pool, JS boundary. [`../phase-2/`](../phase-2/00-overview.md) |
| `packages/binding` | Internal, **not published**. Phase 4 replaces how this is consumed |
| `@emquad/core` | Done. Public API, both pools, `EmquadError` |
| `@emquad/resolver` | Done. Zero runtime dependencies |
| `@emquad/fonts` | Done. 17 files, four licenses, checksummed |
| Distribution | **Not started.** Phase 4 |

64 Rust tests, 115 Node tests. `pnpm test`, `pnpm lint`, `pnpm fmt:check`, `pnpm typecheck` all
clean.

## Phase 4's jobs

### 1. Replace the binding seam — this is the first thing to do

`packages/core/src/binding.ts` is the **only** file that imports `@emquad/binding`. Everything
else in `@emquad/core` goes through it. That was arranged deliberately so this change is small.

`@emquad/binding` is private and unpublishable; `@emquad/core` currently declares it as
`"workspace:*"`, which `pnpm publish` will refuse. Replace it with the napi-generated loader
vendored into `@emquad/core`, plus `optionalDependencies` on
`@emquad/typst-binding-<platform>` — one per target, each carrying a `.node`.

The generated loader in `packages/binding/index.js` already contains the full platform-resolution
chain including musl detection. Do not hand-roll it.

`test/packaging.test.js` links `@emquad/binding` by symlink today, with a comment saying so.
Once real platform packages exist, that test becomes a true clean-room install and the symlink
should go.

### 2. The build matrix

All 14 targets were verified in Phase 0. `packages/binding/package.json` already lists eight in
`napi.targets`.

**The three `win32-*-msvc` targets cannot be cross-compiled** — `stacker` compiles `windows.c` and
`psm` needs `lib.exe`. Native runners are required. `spike/xtarget/sweep2.sh` has the working
environment for the other eleven.

### 3. Packaging tests on the real matrix

- Each platform package installs and loads on its target.
- `optionalDependencies` resolution skips incompatible platforms rather than failing.
- The clean-consumer ESM smoke test, from a registry rather than a symlink.

### 4. CI — already written, never yet run

Four workflows exist under `.github/workflows/`, covering the shape in
[`../plan/07-testing-strategy.md`](../plan/07-testing-strategy.md). `actionlint` passes on all of
them, but **no run has ever happened** — there was no remote when they were written. Expect to
shake something out on the first push. Details in [`04-tooling.md`](04-tooling.md#continuous-integration).

`release.yml` deliberately fails its preflight until job 1 above is done, naming exactly what is
missing.

Two things to watch on the first real run:

- **The golden files may fail on Linux or Windows.** References were generated on
  `aarch64-apple-darwin` and the 0.1% pixel threshold is what absorbs cross-architecture
  rasterization differences — but whether it is *wide enough* has never been tested, because
  there was nowhere to test it. If a runner exceeds it, the diff mask is uploaded as an artifact.
  **Read it before touching the threshold.** A missing table header moves thousands of pixels;
  antialiasing moves tens. If it turns out to be genuine cross-architecture noise, per-architecture
  references are the honest fix, not a wider threshold.
- **The musl and cross targets are the least certain.** Phase 0 proved all fourteen targets
  *compile* using a host approximation of the cross environment (`spike/xtarget/sweep2.sh`). The
  workflow uses napi-rs's Alpine image and `--use-napi-cross` instead, which is the documented
  path but not the one that was measured.

## Things not to break

- **Canonical VFS paths.** Per-request filenames leak an interned `FileId` permanently and abort
  the process at ~65k renders. The guard trips at 50,000 naming the pattern.
- **Never let a panic reach Node.** It aborts the process. Three layers of `catch_unwind`.
- **No `timeout` on `compile()`.** `pool.timeoutMs` exists only for `pool.mode: "process"`, and
  setting it without that is a construction error rather than a no-op. That refusal is what keeps
  hard rule 3 intact — see [`03-findings.md`](03-findings.md#7).
- **`pinRayon` stays `false`.** Measured, not assumed.
- **Zero `-sys` crates** except `napi-sys` and `windows-sys`. `scripts/check-no-sys-crates.sh`
  enforces it on every commit. This is why networking lives in `@emquad/resolver`.
- **Never subset the fonts.** `NewCM10-Regular.otf` is GPL-3.0-or-later and the Distribution
  Exception is void if the glyphs change. `packages/fonts/test/fonts.test.js` enforces it by
  checksum. To shrink the payload, drop whole families — `fontsExcept()` is there for that.
- **Never regenerate goldens to make CI pass.** Read the diff artifact first.

## Two facts worth carrying forward

**The process pool is not a fallback, it is a 6.9× difference on the documents it targets** — and
0.66× on the ones it does not. `pool.mode` is a document-shape decision. Both directions are
measured in [`03-findings.md`](03-findings.md#1).

**SVG text can vanish silently.** An SVG naming an unregistered font emits no diagnostic at all,
and with no serif family registered the text renders as *nothing* — valid PDF, successful compile,
zero warnings. Pinned by tests. If Phase 4 writes user-facing docs, this belongs in them.

## Still unresolved

1. **The throughput discrepancy** — 652 µs (Phase 1) against 532 µs (Phase 0), unexplained.
   Phase 3's figures lean toward the Phase 1 number being right. **Publish no throughput number
   until this is settled**, including in any launch material Phase 5 writes.
2. **Why per-thread rayon pinning differs from `RAYON_NUM_THREADS=1`.** Lower stakes now that the
   collapse has a working answer, but still unexplained.
3. **What the process-global contention actually is.** rayon is ruled out; `comemo` is the
   suspect; nobody has confirmed it.

## Deferred cleanup

`spike/` is still present, with a TODO table in `spike/README.md` listing what each probe was for
and when it can go. Phase 4 or 5 should delete it — its findings are all in
[`../discovery/`](../discovery/00-overview.md).
