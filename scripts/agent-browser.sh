#!/bin/bash
set -euo pipefail

REF="v0.33.0"

CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/terminal-browser/agent-browser/$REF"
BIN="$CACHE/bin/agent-browser"

if [ "${1:-}" = "--ref" ]; then
  echo "$REF"
  exit 0
fi

if [ ! -x "$BIN" ] || [ "${1:-}" = "--force" ]; then
  echo "building agent-browser $REF (first run, a few minutes)…" >&2
  cargo install --git https://github.com/vercel-labs/agent-browser \
    --tag "$REF" --locked --root "$CACHE" agent-browser >&2
fi

echo "$BIN"
