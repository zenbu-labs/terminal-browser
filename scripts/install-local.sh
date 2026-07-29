#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist-release"
MANIFEST="$OUT/manifest.json"

if [ ! -f "$MANIFEST" ]; then
  echo "nothing built yet — run: pnpm build:dist" >&2
  exit 1
fi

field() { node -p "require('$MANIFEST')['$1']"; }

TARBALL="$OUT/$(field file)"
if [ ! -f "$TARBALL" ]; then
  echo "manifest points at $(basename "$TARBALL") but it is missing — run: pnpm build:dist" >&2
  exit 1
fi

# the same installer the published one runs, pointed at the build sitting in dist-release
sed -e "s|__DOWNLOAD_URL__|file://$TARBALL|" \
  -e "s|__VERSION__|$(field version)|" \
  -e "s|__CHANNEL__|$(field channel)|" \
  -e "s|__SHA256__|$(field sha256)|" \
  -e "s|__SIZE__|$(field size)|" \
  "$ROOT/scripts/install.sh" | bash
