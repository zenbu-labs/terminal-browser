#!/bin/bash
set -euo pipefail

BUMP="${1:-patch}"
case "$BUMP" in
  patch|minor|major) ;;
  *) echo "usage: next-version.sh [patch|minor|major]" >&2; exit 1 ;;
esac

LATEST="$(git tag --list 'v*' --sort=-v:refname | head -1)"
if [ -z "$LATEST" ]; then
  echo "v0.1.0"
  exit 0
fi

IFS=. read -r MAJOR MINOR PATCH <<< "${LATEST#v}"
case "$BUMP" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac
echo "v$MAJOR.$MINOR.$PATCH"
