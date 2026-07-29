#!/bin/zsh
# Q5, second pass. The first pass failed because cc-rs looks for a
# target-prefixed gcc that does not exist on a bare macOS host. psm only needs
# to *assemble* a .s file — no libc headers — so plain clang with an explicit
# -target should be sufficient. This approximates what napi's --use-napi-cross
# (and zig cc) provide in CI.
cd "$(dirname "$0")" || exit 1

targets=(
  "darwin-arm64:aarch64-apple-darwin"
  "darwin-x64:x86_64-apple-darwin"
  "linux-x64-gnu:x86_64-unknown-linux-gnu"
  "linux-arm64-gnu:aarch64-unknown-linux-gnu"
  "linux-arm-gnueabihf:armv7-unknown-linux-gnueabihf"
  "linux-x64-musl:x86_64-unknown-linux-musl"
  "linux-arm64-musl:aarch64-unknown-linux-musl"
  "win32-x64-msvc:x86_64-pc-windows-msvc"
  "win32-arm64-msvc:aarch64-pc-windows-msvc"
  "win32-ia32-msvc:i686-pc-windows-msvc"
  "freebsd-x64:x86_64-unknown-freebsd"
  "android-arm64:aarch64-linux-android"
  "android-arm-eabi:armv7-linux-androideabi"
  "wasm32-wasip1-threads:wasm32-wasip1-threads"
)

printf "%-24s %-32s %-8s %s\n" "NAPI PLATFORM" "RUST TRIPLE" "RESULT" "NOTE"
for entry in "${targets[@]}"; do
  napi="${entry%%:*}"
  triple="${entry##*:}"
  envvar="CC_${triple//-/_}"
  flagvar="CFLAGS_${triple//-/_}"
  log="/tmp/xtarget2-$triple.log"

  if env "$envvar=clang" "$flagvar=-target $triple" \
       cargo check --quiet --target "$triple" >"$log" 2>&1; then
    note="psm assembled"
    grep -q "has no assembly files" "$log" && note="NO PSM ASM (stack cannot grow)"
    printf "%-24s %-32s %-8s %s\n" "$napi" "$triple" "OK" "$note"
  else
    reason=$(grep -m1 -E "error occurred in cc-rs|^error(\[|:)" "$log" | cut -c1-80)
    printf "%-24s %-32s %-8s %s\n" "$napi" "$triple" "FAIL" "$reason"
  fi
done
