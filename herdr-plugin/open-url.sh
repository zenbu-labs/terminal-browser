#!/usr/bin/env bash
set -euo pipefail

url="${HERDR_PLUGIN_CLICKED_URL:-}"
if [ -z "$url" ]; then
  echo "no clicked url — herdr did not set HERDR_PLUGIN_CLICKED_URL" >&2
  exit 1
fi

exec "${HERDR_BIN_PATH:-herdr}" plugin pane open \
  --plugin zenbu-labs.terminal-browser \
  --entrypoint browser \
  --placement split \
  --target-pane "$HERDR_PANE_ID" \
  --direction right \
  --env "TB_URL=$url" \
  --focus
