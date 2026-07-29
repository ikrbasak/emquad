#!/bin/zsh
# Q5 — does the psm/stacker assembly dependency build for every matrix target?
# `cargo check` runs build scripts, which is exactly where psm assembles its
# per-architecture .s files. Linking is not exercised (that is napi's job).
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
  log="/tmp/xtarget-$triple.log"
  if cargo check --quiet --target "$triple" >"$log" 2>&1; then
    note=""
    grep -q "has no assembly files" "$log" && note="NO PSM ASM (stack cannot grow)"
    printf "%-24s %-32s %-8s %s\n" "$napi" "$triple" "OK" "$note"
  else
    reason=$(grep -m1 -E "error(\[|:)" "$log" | cut -c1-90)
    printf "%-24s %-32s %-8s %s\n" "$napi" "$triple" "FAIL" "$reason"
  fi
done
