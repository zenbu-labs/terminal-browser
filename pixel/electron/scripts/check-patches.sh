#!/usr/bin/env bash
# Verify every patch in patches/ applies cleanly to a given electron version.
# Usage: check-patches.sh <version, e.g. 43.1.1>
# Exits non-zero with a loud message on any conflict.
set -euo pipefail

VERSION="${1:?usage: check-patches.sh <electron version>}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Cloning electron v$VERSION (shallow)..."
git clone --quiet --depth 1 --branch "v$VERSION" https://github.com/electron/electron "$WORK/electron"

# patches form an ordered series, so each one is applied before checking the next
failed=0
for patch in "$REPO_DIR"/patches/*.patch; do
  name="$(basename "$patch")"
  if git -C "$WORK/electron" apply "$patch" 2>"$WORK/err.txt"; then
    echo "OK       $name"
  else
    failed=1
    echo "CONFLICT $name"
    sed 's/^/         /' "$WORK/err.txt"
  fi
done

if [ "$failed" -ne 0 ]; then
  echo ""
  echo "PATCH CONFLICT against electron v$VERSION — the patch needs a manual rebase."
  exit 1
fi
echo "All patches apply cleanly to electron v$VERSION."
