#!/usr/bin/env bash
#
# Pinned against unpinned typst rayon, at each pool size, one configuration per
# process.
#
#   ./bench/poolcmp.sh              # invoice
#   ./bench/poolcmp.sh multirun     # the shape where pinning is supposed to pay
#
# Separate processes are not optional: `comemo`'s cache is process-global, and
# whichever configuration runs second in a shared process harvests the first
# one's cache. Alternating order stops a thermal ramp or a warm page cache from
# masquerading as a result.
#
# Build the addon first: `pnpm --filter @emquad/typst-binding run build`.

set -euo pipefail

cd "$(dirname "$0")/.."

DOC="${1:-invoice}"
DOCS="${EMQUAD_DOCS:-400}"
REPS="${REPS:-2}"

echo "document: $DOC, $DOCS compiles per size, $REPS repetitions"
echo

for rep in $(seq 1 "$REPS"); do
  if [ $((rep % 2)) -eq 1 ]; then order="1 0"; else order="0 1"; fi
  for pin in $order; do
    echo "--- rep $rep, pinRayon=$pin ---"
    EMQUAD_DOCS="$DOCS" EMQUAD_PIN="$pin" node bench/pool.js "$DOC" | tail -n +3
  done
done
