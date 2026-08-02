#!/usr/bin/env bash
# Publish the eight `@emquad/typst-binding-<platform>` packages, resumably.
#
#   ./scripts/publish-platform-packages.sh
#
# Used by `release.yml` on both the OIDC and the token path. Credentials come
# from the environment; this script never handles them.
#
# # Why not `napi pre-publish`
#
# It is all-or-nothing. It shells out to `npm publish` for every platform
# package, and npm refuses to republish an existing version, so a run that dies
# partway can never be restarted — the retry fails immediately on the first
# package that already went out, and the only way forward is a version bump.
#
# That happened during the `0.0.1` bootstrap, six packages in, and
# `scripts/initial-publish.sh` was rewritten to publish individually. This is
# the same fix for the workflow, where it matters more: the OIDC step and the
# token fallback run this same script, so without skip-if-published a partial
# OIDC publish would strand the release outright.
#
# The one thing napi does that this does not is rewrite the loader's
# `optionalDependencies` — `scripts/sync-binding-optional-deps.mjs` does that,
# immediately after this runs.

set -euo pipefail

cd "$(dirname "$0")/.."

version=$(node -p "require('./packages/binding/package.json').version")
published=0
skipped=0

echo "publishing platform packages at $version"

for dir in packages/binding/npm/*/; do
  name=$(node -p "require('./$dir/package.json').name")

  # A `.node` is not optional. A platform package published without its binary
  # installs cleanly and then throws "Cannot find native binding" at require
  # time, on that platform only, for as long as the version exists.
  if ! ls "$dir"*.node >/dev/null 2>&1; then
    echo "::error::$name has no .node — the build artifacts were not staged"
    exit 1
  fi

  if npm view "$name@$version" version >/dev/null 2>&1; then
    echo "  skip, already published: $name@$version"
    skipped=$((skipped + 1))
    continue
  fi

  if npm publish "$dir" --access public; then
    echo "  published: $name@$version"
    published=$((published + 1))
  elif npm view "$name@$version" version >/dev/null 2>&1; then
    # `npm view` lags a successful publish: the write is accepted before the
    # read is served, so a package can be absent above and present here. Treat a
    # failed publish whose version is now visible as done, or a resumed run
    # trips over its own success.
    echo "  already published, view had lagged: $name@$version"
    skipped=$((skipped + 1))
  else
    echo "::error::failed to publish $name@$version"
    exit 1
  fi
done

echo "platform packages at $version: $published published, $skipped already up"

if [ "$((published + skipped))" -ne 8 ]; then
  echo "::error::expected 8 platform packages, handled $((published + skipped))"
  exit 1
fi
