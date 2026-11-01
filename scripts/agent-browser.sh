#!/bin/bash
set -euo pipefail

REF="v0.38.1"
COMMIT="aff6125c023b810ea3f2e5deec5379e9a4270bdc"
PATCH="$(cd "$(dirname "$0")" && pwd)/agent-browser.patch"
PATCH_HASH="$(shasum -a 256 "$PATCH" | cut -c1-12)"

CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/terminal-browser/agent-browser/$REF-$PATCH_HASH"
BIN="$CACHE/bin/agent-browser"

if [ "${1:-}" = "--ref" ]; then
  echo "$REF"
  exit 0
fi

if [ ! -x "$BIN" ] || [ "${1:-}" = "--force" ]; then
  echo "building agent-browser $REF (first run, a few minutes)…" >&2
  SRC="$(mktemp -d)"
  trap 'rm -rf "$SRC"' EXIT
  git clone --quiet --depth 1 --branch "$REF" https://github.com/vercel-labs/agent-browser "$SRC" >&2
  if [ "$(git -C "$SRC" rev-parse HEAD)" != "$COMMIT" ]; then
    # fixme: placeholder copy
    echo "agent-browser $REF is not commit $COMMIT; refusing to build" >&2
    exit 1
  fi
  git -C "$SRC" apply "$PATCH"
  cargo install --path "$SRC/cli" --locked --root "$CACHE" >&2
fi

echo "$BIN"
