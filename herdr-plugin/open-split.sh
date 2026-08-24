#!/usr/bin/env bash
set -euo pipefail

exec "${HERDR_BIN_PATH:-herdr}" plugin pane open \
  --plugin zenbu-labs.terminal-browser \
  --entrypoint browser \
  --placement split \
  --target-pane "$HERDR_PANE_ID" \
  --direction right \
  --focus
