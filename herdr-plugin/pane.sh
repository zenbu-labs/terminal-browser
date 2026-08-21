#!/usr/bin/env bash
set -euo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

bin="$(tb_bin)" || { tb_missing_message; exit 1; }

# herdr already created this pane, so open in place rather than splitting again.
if [ -n "${TB_URL:-}" ]; then
  exec "$bin" open "$TB_URL"
fi

exec "$bin" open
