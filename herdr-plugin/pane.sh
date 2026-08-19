#!/usr/bin/env bash
set -euo pipefail

if ! command -v terminal-browser >/dev/null 2>&1; then
  echo "terminal-browser is not installed — see https://github.com/zenbu-labs/terminal-browser" >&2
  exit 1
fi

# herdr already created this pane, so open in place rather than splitting again.
if [ -n "${TB_URL:-}" ]; then
  exec terminal-browser open "$TB_URL"
fi

exec terminal-browser open
