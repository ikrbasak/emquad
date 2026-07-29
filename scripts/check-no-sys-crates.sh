#!/usr/bin/env bash
#
# Guards hard rule 4: the Rust dependency tree must stay free of `-sys` crates.
#
# Zero `-sys` crates means no OpenSSL, no bindgen, no cmake, and no per-platform
# C toolchain beyond what `psm`/`stacker` already need. That single property is
# what makes a 14-target build matrix affordable, and it is why networking lives
# in TypeScript rather than in Rust. It is lost one careless dependency at a
# time, so it is checked rather than remembered.
#
# Two crates are allowed, both bindings-only with no C build step:
#
# * `windows-sys` — pulled in transitively on Windows targets by std-adjacent
#   dependencies.
# * `napi-sys` — declares the extern N-API symbols, which are resolved against
#   the host Node binary at load time. No C library, no bindgen, no cmake. It is
#   unavoidable for a Node addon and costs us nothing on the target matrix.

set -euo pipefail

ALLOWED='^(windows-sys|napi-sys)$'

offenders=$(
  cargo metadata --format-version 1 --all-features |
    node -e '
      let raw = "";
      process.stdin.on("data", (chunk) => (raw += chunk));
      process.stdin.on("end", () => {
        const meta = JSON.parse(raw);
        const names = new Set(meta.packages.map((p) => p.name));
        for (const name of [...names].sort()) {
          if (name.endsWith("-sys")) console.log(name);
        }
      });
    ' | grep -Ev "$ALLOWED" || true
)

if [ -n "$offenders" ]; then
  echo "error: -sys crates entered the dependency tree (hard rule 4):" >&2
  echo "$offenders" | sed 's/^/  /' >&2
  echo >&2
  echo "These drag in C toolchains and break the cross-compile matrix." >&2
  echo "See .claude/discovery/06-distribution.md before allowing one." >&2
  exit 1
fi

echo "no -sys crates in the dependency tree"
