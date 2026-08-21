#!/usr/bin/env bash
set -euo pipefail

# A checkout being worked on can point this at its own build without installing over the
# copy on PATH.
bin="${TERMINAL_BROWSER_BIN:-}"
if [ -z "$bin" ]; then
  if ! command -v terminal-browser >/dev/null 2>&1; then
    echo "terminal-browser is not installed — see https://github.com/zenbu-labs/terminal-browser" >&2
    exit 1
  fi
  bin=terminal-browser
fi

# herdr already created this pane, so open in place rather than splitting again.
if [ -n "${TB_URL:-}" ]; then
  exec "$bin" open "$TB_URL"
fi

exec "$bin" open
