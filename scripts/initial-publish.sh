#!/usr/bin/env bash
#
# First publish. Run this once, by hand, and then never again.
#
# It exists because npm's trusted publishing (OIDC) cannot publish a package
# that does not yet exist: a trusted publisher is configured in a package's
# settings, and those settings need the package to be there first
# (npm/cli#8544). So every one of these packages needs exactly one
# token-authenticated release before `release.yml` can take over on OIDC.
#
#   NPM_TOKEN=npm_xxx ./scripts/initial-publish.sh            # dry run
#   NPM_TOKEN=npm_xxx ./scripts/initial-publish.sh --execute   # for real
#
# Publishing is effectively irreversible — npm only allows unpublishing within
# 72 hours, and refuses entirely once anything depends on the version — so this
# refuses to do anything real without `--execute`.
#
# ORDER IS THE WHOLE POINT. The eight platform packages must land before
# @emquad/typst-binding declares them, and that declaration cannot be committed
# any earlier: pnpm silently drops an optional dependency it cannot resolve and
# never writes it to the lockfile, so `--frozen-lockfile` would fail in every CI
# job until the packages actually exist. That is why step 3 edits a manifest
# mid-run rather than it being committed up front.

set -euo pipefail

cd "$(dirname "$0")/.."

EXECUTE=0
[ "${1:-}" = "--execute" ] && EXECUTE=1

TOKEN="${NPM_TOKEN:-${NODE_AUTH_TOKEN:-}}"
BINDING=packages/binding/package.json
REGISTRY=https://registry.npmjs.org

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() { printf '\033[31merror: %s\033[0m\n' "$1" >&2; exit 1; }

run() {
  if [ "$EXECUTE" = 1 ]; then
    "$@"
  else
    printf '  would run: %s\n' "$*"
  fi
}

# --- preconditions -----------------------------------------------------------
# Every one of these is something that produces a broken *published* package
# rather than a failed command, which is why they are checked before anything
# is sent rather than being left to npm.

say "Checking preconditions"

[ -n "$TOKEN" ] || die "set NPM_TOKEN (or NODE_AUTH_TOKEN) — OIDC cannot make a package that does not exist yet"

command -v jq >/dev/null || die "jq is required"

VERSION=$(jq -r .version "$BINDING")
[ "$VERSION" != "0.0.0" ] || die "version is still 0.0.0 — run \`pnpm changeset\` and \`pnpm changeset:version\` first"

# The .node files are what the platform packages exist to carry. Publishing
# them empty produces packages that install fine and fail at require time on
# every platform, which is the worst possible shape of failure here.
missing=0
for dir in packages/binding/npm/*/; do
  name=$(jq -r .name "$dir/package.json")
  main=$(jq -r .main "$dir/package.json")
  if [ ! -f "$dir/$main" ]; then
    printf '  missing binary: %s (%s)\n' "$name" "$main"
    missing=$((missing + 1))
  fi
done
[ "$missing" = 0 ] || die "$missing platform package(s) have no .node — run the build matrix and \`napi artifacts\` first"

count=$(find packages/binding/npm -maxdepth 1 -mindepth 1 -type d | wc -l | tr -d ' ')
targets=$(jq -r '.napi.targets | length' "$BINDING")
[ "$count" = "$targets" ] || die "found $count platform dirs but napi.targets lists $targets"

printf '  version:  %s\n' "$VERSION"
printf '  platform: %s packages, all with binaries\n' "$count"
printf '  mode:     %s\n' "$([ "$EXECUTE" = 1 ] && echo 'EXECUTE — this will publish' || echo 'dry run')"

export NODE_AUTH_TOKEN="$TOKEN"
export NPM_CONFIG_PROVENANCE=false # provenance needs CI's OIDC; this is a laptop

# The token goes in a mode-600 temp file outside the repo, not a project-level
# `.npmrc`. `.npmrc` is not gitignored here, so a run killed before its trap
# fires — SIGKILL, a closed laptop — would leave a live token in a file that
# `git add .` would happily stage. Nothing is written inside the working tree.
NPMRC=$(mktemp)
chmod 600 "$NPMRC"
printf '//%s/:_authToken=%s\n' "${REGISTRY#https://}" "$TOKEN" >"$NPMRC"
export NPM_CONFIG_USERCONFIG="$NPMRC"
trap 'rm -f "$NPMRC"' EXIT INT TERM

# --- 1. platform packages ----------------------------------------------------

say "1/4  Publishing the eight platform packages"
echo "     These carry the .node files and must exist before anything depends on them."
run pnpm exec napi prepublish --skip-gh-release --tag-style npm

# --- 2. wait for the registry ------------------------------------------------

say "2/4  Waiting for the registry to serve them"
if [ "$EXECUTE" = 1 ]; then
  for dir in packages/binding/npm/*/; do
    name=$(jq -r .name "$dir/package.json")
    for attempt in $(seq 1 30); do
      if npm view "$name@$VERSION" version >/dev/null 2>&1; then
        printf '  ok: %s\n' "$name"
        break
      fi
      [ "$attempt" = 30 ] && die "$name never appeared on the registry"
      sleep 4
    done
  done
else
  echo "  would poll npm for each @emquad/typst-binding-<platform>@$VERSION"
fi

# --- 3. declare them ---------------------------------------------------------
# Only now can this be written down. Before the packages exist, pnpm refuses to
# lock the specifiers and every `--frozen-lockfile` install breaks.

say "3/4  Declaring optionalDependencies and dropping \`private\`"
if [ "$EXECUTE" = 1 ]; then
  deps=$(for dir in packages/binding/npm/*/; do
    jq -r --arg v "$VERSION" '{(.name): $v}' "$dir/package.json"
  done | jq -s 'add')

  tmp=$(mktemp)
  jq --argjson deps "$deps" 'del(.private) | .optionalDependencies = $deps' "$BINDING" >"$tmp"
  mv "$tmp" "$BINDING"

  pnpm install --no-frozen-lockfile
  echo "  $BINDING updated — commit this along with pnpm-lock.yaml"
else
  echo "  would add 8 optionalDependencies at $VERSION, delete \`private\`, and refresh the lockfile"
fi

# --- 4. the rest -------------------------------------------------------------

say "4/4  Publishing the workspace packages"
echo "     changeset publish orders these topologically and skips anything already up."
run pnpm exec changeset publish --no-git-tag

# --- what is left to do by hand ----------------------------------------------

say "Done — two manual steps remain"
cat <<'EOF'
  1. Commit packages/binding/package.json and pnpm-lock.yaml. Until that lands,
     the repo still says the binding is private and declares no platform
     packages, and CI will not match what is on the registry.

  2. Configure a trusted publisher for each of the 11 packages, at
     https://www.npmjs.com/package/<name>/access

       repository:  ikrbasak/emquad
       workflow:    release.yml

     Until that is done for a package, release.yml will fall back to the token
     for it and log a warning naming which path it used. That warning is the
     signal that a package still has not been switched over.
EOF
