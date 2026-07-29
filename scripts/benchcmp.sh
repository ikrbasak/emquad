#!/usr/bin/env bash
#
# Compare typst-rayon-pinned against unpinned throughput, one configuration per
# process.
#
#   ./scripts/benchcmp.sh              # invoice
#   ./scripts/benchcmp.sh multirun     # the shape where pinning is supposed to pay
#
# Why separate processes: `comemo` is process-global, and disjoint document
# *indices* are not disjoint *work*. Two invoices differing only in a
# substituted number share almost all of their layout, so whichever
# configuration runs second in a shared process harvests the first one's cache
# and looks ~20% faster than it is. That is hard rule 10 in a subtler form, and
# it produced a wrong answer here before it was caught.
#
# Each run is also repeated, alternating order, because a single pair of runs
# cannot distinguish a real difference from machine noise.

set -euo pipefail

DOC="${1:-invoice}"
DOCS="${EMQUAD_DOCS:-2000}"
REPS="${REPS:-3}"

cargo build --profile bench --bench compile >/dev/null 2>&1
BIN=$(find target/release/deps -name 'compile-*' -type f -perm -111 ! -name '*.d' \
  -exec ls -t {} + | head -1)

echo "document: $DOC, $DOCS compiles, $REPS repetitions per configuration"
echo

for rep in $(seq 1 "$REPS"); do
  # Alternate which configuration goes first so a warm page cache or a thermal
  # ramp cannot systematically favor one of them.
  if [ $((rep % 2)) -eq 1 ]; then
    order="1 0"
  else
    order="0 1"
  fi
  for pin in $order; do
    EMQUAD_DOC="$DOC" EMQUAD_DOCS="$DOCS" EMQUAD_PIN="$pin" "$BIN" |
      awk -v rep="$rep" -v pin="$pin" '
        /distinct documents/ {
          printf "  rep %s  pin=%s  %8.1f us  %6.0f docs/s\n", rep, pin, $3, $5
        }'
  done
done
