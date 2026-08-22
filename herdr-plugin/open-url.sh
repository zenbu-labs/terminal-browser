#!/usr/bin/env bash
set -euo pipefail

url="${HERDR_PLUGIN_CLICKED_URL:-}"
if [ -z "$url" ]; then
  echo "no clicked url — herdr did not set HERDR_PLUGIN_CLICKED_URL" >&2
  exit 1
fi

root="$(dirname "${BASH_SOURCE[0]}")"
. "$root/lib.sh"

# A clicked link belongs in the browser that is already on screen. Only when there is none
# to reuse does this split a new one, so clicking three links gives three tabs, not three
# browsers. pick-browser.sh explains which browser counts as reusable.
key="$("$root/pick-browser.sh" || true)"
if [ -n "$key" ]; then
  bin="$(tb_bin)" || { tb_missing_message; exit 1; }
  # Falls through to the split when this fails, so a browser that died between being
  # listed and being handed the url still leaves the click with something to show.
  if "$bin" new-tab "$url" --browser "$key"; then
    exit 0
  fi
  echo "could not open a tab in browser $key — opening a browser instead" >&2
fi

exec "${HERDR_BIN_PATH:-herdr}" plugin pane open \
  --plugin zenbu-labs.terminal-browser \
  --entrypoint browser \
  --placement split \
  --target-pane "$HERDR_PANE_ID" \
  --direction right \
  --env "TB_URL=$url" \
  --focus
