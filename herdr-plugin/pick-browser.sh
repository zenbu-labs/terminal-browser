#!/usr/bin/env bash
# Prints the key of a running browser that the clicking pane can actually see, or nothing.
#
# The rule, best match first:
#   1. a browser in the same herdr tab as the click — on screen next to it right now
#   2. a browser elsewhere in the same herdr workspace — one tab switch away
# A browser in another workspace is never chosen. Sending the tab there would put the page
# somewhere the operator is not looking, so the click would read as having done nothing,
# and following it would drag them across spaces. Splitting a browser into the workspace
# they clicked in is visible and is what they already expect when there is no browser yet.
#
# Ties keep the order terminal-browser lists them in, which is oldest first — the same
# tie-break `terminal-browser new-tab` applies when it picks a browser on its own.
#
# Prints nothing and succeeds when there is nothing to reuse, when jq is missing, or when
# either query fails. Every one of those means the caller opens a browser instead.
set -uo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

command -v jq >/dev/null 2>&1 || exit 0
bin="$(tb_bin)" || exit 0
herdr_bin="${HERDR_BIN_PATH:-herdr}"

tab="${HERDR_TAB_ID:-}"
workspace="${HERDR_WORKSPACE_ID:-}"
[ -n "$tab$workspace" ] || exit 0

running="$("$bin" ls --all --json 2>/dev/null)" || exit 0
# Browsers report the pane they render into, not its workspace, so the pane list supplies
# the pane -> workspace mapping.
panes="$("$herdr_bin" pane list 2>/dev/null)" || panes='{}'

jq -r \
  --argjson panes "${panes:-\{\}}" \
  --arg tab "$tab" \
  --arg workspace "$workspace" '
  ([($panes.result.panes // [])[] | {key: .pane_id, value: .workspace_id}] | from_entries) as $where
  | [ (.browsers // [])[]
      | select(.key != null)
      | { key,
          rank: (
            if $tab != "" and (.pane.tab // "") == $tab then 0
            elif $workspace != "" and ($where[.pane.pane // ""] // "") == $workspace then 1
            else empty
            end
          )
        }
    ]
  | sort_by(.rank)
  | .[0].key // empty
' <<<"${running:-\{\}}"
