#!/bin/bash
set -euo pipefail

BUMP="${1:-patch}"
case "$BUMP" in
  patch|minor|major) ;;
  *) echo "usage: tag-release.sh [patch|minor|major]" >&2; exit 1 ;;
esac

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "working tree is dirty — commit or stash first" >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || { echo "releases are cut from main, not $BRANCH" >&2; exit 1; }

git fetch -q origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "main is out of sync with origin — push or pull first" >&2
  exit 1
fi

LATEST="$(git tag --list 'v*' --sort=-v:refname | head -1)"
NEXT="$("$(dirname "$0")/next-version.sh" "$BUMP")"

git tag -a "$NEXT" -m "terminal-browser $NEXT"
git push -q origin "$NEXT"

echo "tagged ${LATEST:-none} -> $NEXT"
echo "watch it build:  gh run watch"
