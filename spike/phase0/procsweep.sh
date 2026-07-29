#!/bin/zsh
# Q3 discriminator: threads share the process-global `comemo` cache; separate
# processes do not. If N processes scale past the point where N threads
# plateau, the limit is cache contention. If both plateau together, the limit
# is the hardware (an M1 has only 4 performance cores).
cd "$(dirname "$0")" || exit 1

per=${1:-400}
echo "procs\ttotal_docs\twall_ms\tdocs_per_sec\tspeedup"
base=0
for n in 1 2 3 4 5 6 8 10 12 16; do
  start=$(python3 -c 'import time; print(int(time.time()*1000))')
  for i in $(seq 1 $n); do
    PHASE0_DOC=${PHASE0_DOC:-invoice} ./target/release/pool "$per" 1 >/dev/null 2>&1 &
  done
  wait
  end=$(python3 -c 'import time; print(int(time.time()*1000))')
  wall=$((end - start))
  total=$((n * per))
  dps=$(python3 -c "print(f'{$total/($wall/1000):.0f}')")
  [[ $n -eq 1 ]] && base=$dps
  sp=$(python3 -c "print(f'{$dps/$base:.2f}')")
  printf "%s\t%s\t%s\t%s\t%sx\n" "$n" "$total" "$wall" "$dps" "$sp"
done
