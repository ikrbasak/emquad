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

### 1. Replace the binding seam — mostly done

`packages/core/src/binding.ts` is the **only** file that imports the binding. Everything else in
`@emquad/core` goes through it. That was arranged deliberately so this change would be small,
and it was.

**What changed, and why it is not what this document originally proposed.** The plan was to
vendor the napi loader into `@emquad/core` and hang the platform packages off *core's*
`optionalDependencies`. That was rejected in favour of the standard napi-rs layout: the package
in `packages/binding` was **renamed `@emquad/binding` → `@emquad/typst-binding`** and becomes the
published loader package, carrying the platform packages as its own `optionalDependencies`.
`@emquad/core` depends on it normally.

Vendoring loses on every axis that matters:

| | vendor into core | rename (chosen) |
|---|---|---|
| the loader | a *copy* of a generated file, free to rot | generated in place, cannot drift |
| the dev `.node` | needs copying into `packages/core/dist/` | already sits beside the loader |
| shipping 29 MB by accident | one `files` line stands in the way | structurally impossible |
| published packages | 2 | 3 |

The one real cost is that third published package. It buys away a build-time copy step, a
`files`/`.npmignore` exclusion whose failure mode is publishing a 29 MB binary on every platform,
and a generated file kept in sync by hand.

**Done:** the rename, `napi.packageName = "@emquad/typst-binding"`, and
`packages/binding/npm/` holding the eight generated platform packages, each already declaring
`os`/`cpu`/`libc`. `packages/*` does not glob them, so they are deliberately **not** workspace
members. Full suite, typecheck, and `--frozen-lockfile` all green.

**Left:** drop `private` from `packages/binding/package.json` and add the eight
`optionalDependencies`. Both are blocked, and the block is real:

**pnpm cannot lock a dependency no registry serves.** It excludes an optional dependency it fails
to resolve (`failed compatibility check`) and never writes it to the lockfile — the importer stays
`.: {}`. `pnpm install --frozen-lockfile` then fails with `ERR_PNPM_OUTDATED_LOCKFILE` naming the
specifier as added-but-unlocked. This does not settle after one install: no lockfile entry can
ever exist for a package that is not published, so **every CI job would fail until the first
publish succeeds**. Verified against pnpm 11.17.0.

So the order is forced: publish the platform packages first (`napi prepublish` does this, and
`release.yml` already runs it before anything else), *then* declare them. Rehearse against a local
registry — Verdaccio, or `pnpm publish --dry-run` — rather than burning a real version.

`release.yml`'s preflight now checks exactly this state and fails naming both items. It was
rewritten to test the *shape* of the tree rather than the string `@emquad/binding`, which the
rename would otherwise have satisfied while leaving the actual problem untouched.

`test/packaging.test.js` still symlinks the workspace copy. Once the platform packages are
published it becomes a true clean-room install and the symlink should go.

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

### 4. CI — now running and green

Four workflows exist under `.github/workflows/`, covering the shape in
[`../plan/07-testing-strategy.md`](../plan/07-testing-strategy.md). They had never run when this
was written — there was no remote. They now do, and the first green run is
[30534531284](https://github.com/ikrbasak/emquad/actions/runs/30534531284): 21 jobs, all eight
native targets and the full 3×3 test grid. It took nine fixes to get there, catalogued in
[`04-tooling.md`](04-tooling.md#things-encoded-in-the-workflows-that-are-easy-to-get-wrong).

`release.yml` deliberately fails its preflight until job 1 above is done, naming exactly what is
missing.

Both things this section told you to watch are now settled:

- **The golden files pass everywhere.** References generated on `aarch64-apple-darwin` render
  inside the 0.1% pixel threshold on `x86_64-pc-windows-msvc` and `x86_64-unknown-linux-gnu`,
  across Node 22, 24, and 26. Per-architecture references are **not** needed. The advice still
  stands if this ever changes: read the uploaded diff mask before touching the threshold — a
  missing table header moves thousands of pixels, antialiasing moves tens.
- **Both musl targets build.** The napi-rs Alpine image works, with two caveats worth knowing
  before touching that job: the image is abandoned (frozen 2024-12-01, Node 18) so a current Node
  is installed over it, and `--use-napi-cross` is **glibc-only**, so `aarch64-unknown-linux-musl`
  points `CC_<triple>`/`CXX_<triple>`/`CARGO_TARGET_<TRIPLE>_LINKER` at the image's own toolchain.
  Neither is discoverable from the napi-rs docs; both are in [`04-tooling.md`](04-tooling.md).

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
