#!/usr/bin/env bash
# Thread pool against worker-process pool, across pool sizes.
#
#   ./bench/poolcmp.sh [invoice|multirun] [docs]
#
# One configuration per process, and a disjoint document range per
# configuration. Both are required: `comemo`'s cache is process-global, so a
# second configuration sharing either would harvest the first's memo hits and
# report a difference that is not there (hard rule 10).
#
# The orders alternate between rounds so that thermal drift and CPU frequency
# scaling do not systematically favor whichever runs first.

set -euo pipefail
cd "$(dirname "$0")/.."

DOC="${1:-invoice}"
DOCS="${2:-}"
SIZES=(1 2 4 8)
ROUNDS=2

if [[ -z "$DOCS" ]]; then
  if [[ "$DOC" == "multirun" ]]; then DOCS=150; else DOCS=1500; fi
fi

echo "document=$DOC docs=$DOCS rounds=$ROUNDS"
printf '%-8s %-8s %10s %10s %10s\n' mode size us/doc docs/sec startup_ms

offset=0
for round in $(seq 1 "$ROUNDS"); do
  for size in "${SIZES[@]}"; do
    if (( round % 2 == 1 )); then modes=(thread process); else modes=(process thread); fi
    for mode in "${modes[@]}"; do
      # Every run gets its own document range, never reused.
      offset=$(( offset + DOCS + 1 ))
      out=$(node bench/pool.js "$DOC" "$mode" "$size" "$DOCS" "$offset")
      printf '%-8s %-8s %10s %10s %10s\n' \
        "$mode" "$size" \
        "$(node -e 'console.log(JSON.parse(process.argv[1]).usPerDoc)' "$out")" \
        "$(node -e 'console.log(JSON.parse(process.argv[1]).docsPerSec)' "$out")" \
        "$(node -e 'console.log(JSON.parse(process.argv[1]).startupMs)' "$out")"
    done
  done
done
