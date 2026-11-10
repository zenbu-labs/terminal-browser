#!/bin/bash
# Prints the next pixel release tag (pixel-v<semver>). Counts from the newest pixel-v* tag,
# or from the package's own version when nothing has been tagged yet.
set -euo pipefail

BUMP="${1:-patch}"
case "$BUMP" in
  patch|minor|major) ;;
  *) echo "usage: next-version.sh [patch|minor|major]" >&2; exit 1 ;;
esac

LATEST="$(git tag --list 'pixel-v*' --sort=-v:refname | head -1)"
if [ -z "$LATEST" ]; then
  PKG="$(cd "$(dirname "$0")/.." && pwd)/packages/pixel/package.json"
  LATEST="pixel-v$(node -p "require(process.argv[1]).version" "$PKG")"
fi

IFS=. read -r MAJOR MINOR PATCH <<< "${LATEST#pixel-v}"
case "$BUMP" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac
echo "pixel-v$MAJOR.$MINOR.$PATCH"
