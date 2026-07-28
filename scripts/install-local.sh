#!/bin/bash
set -euo pipefail


ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist-release"

if [ ! -f "$OUT/chunks.txt" ]; then
  echo "nothing built yet — run: pnpm build:dist" >&2
  exit 1
fi

sed "s|__BASE_URL__|file://$OUT|" "$ROOT/scripts/install.sh" | bash
