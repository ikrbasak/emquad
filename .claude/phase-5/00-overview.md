# Phase 5 — benchmarks, docs, launch

The brief is [`../plan/06-phase-5-docs-benchmarks.md`](../plan/06-phase-5-docs-benchmarks.md).

| Document | What it covers |
|---|---|
| [`00-throughput.md`](00-throughput.md) | The Phase 1 / Phase 0 discrepancy, resolved. **Retracts the 532 µs figure.** |
| [`01-puppeteer.md`](01-puppeteer.md) | emquad against Puppeteer, with the harness published |

## What Phase 5 delivered

**A publishable throughput number, and the retraction of the old one.** The 532 µs figure does
not reproduce — the original probe measures 616 µs on the same machine today. Most of the
long-standing 23% "discrepancy" was measurement error, including a benchmark that had been
defaulting to a rayon configuration the library does not use. Per-compile wrapper overhead turned
out to be **zero to within 0.4%**, which refuted the standing suspect list rather than confirming
it. ~15.6% remains, localized to compile work and undiagnosed.

**The Puppeteer comparison**, which is the number that actually drives adoption: **2× to 33×, and the
document decides which.** Published as a runnable harness in
[`../../benchmarks/puppeteer/`](../../benchmarks/puppeteer/README.md) rather than as an
assertion, with an equivalence check that writes both engines' PDFs so the claim can be
inspected.

**Documentation**, against the priority list in the plan — all of it in
[`packages/core/README.md`](../../packages/core/README.md), which is what npm renders, rather
than in a wiki nobody opens. Limitations are stated up front, as the plan insisted: no thread-mode
timeout, untrusted templates need process isolation, no HTML input, pre-1.0 typst, ~30 MB
installed.

**Runnable examples** in [`../../examples/`](../../examples/README.md) — invoice, SVG chart,
multi-page table — each demonstrating a rule that is otherwise learned in production.

## What is still open

- **The residual ~15.6%** against raw typst. Profiling is the next step. It is an optimization
  opportunity, not a defect.
- **`0.0.2` is unreleased.** The declarations fix is staged in a changeset; until it ships,
  TypeScript consumers on a stock `tsconfig.json` see two `TS2304` errors.
- **Trusted publishers are unconfigured** on all 11 packages, so `release.yml` falls back to the
  long-lived token and warns.
- **Seven of eight platforms remain unverified on their own hardware.** Everything measured here
  is `darwin-arm64`.
- **No production templates have been measured.** Both the throughput and the Puppeteer numbers
  use synthetic documents built to be fair rather than favourable, but they are not anyone's real
  invoice.

## The methodological lesson, twice over

Both investigations in this phase produced a confident wrong answer before the right one, and
both times the mechanism was the same: **a result that appears exactly when you change one
variable is not evidence that the variable caused it.**

The throughput gap looked like wrapper overhead for three phases; it was a benchmark default plus
two numbers taken on differently-loaded machines months apart. The Puppeteer harness produced
Chromium launch failures that looked exactly like a live `Compiler` blocking them, and were two
edits from being written up as a known product defect; they were machine load, and do not
reproduce.

The repo already had hard rule 10 for the document-level version of this. The phase-level version
is: **compare within one session, on a quiet machine, or do not compare.**
