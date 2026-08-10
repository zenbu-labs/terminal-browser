#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist-release"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) TARGET=darwin-arm64 ;;
  Linux-x86_64|Linux-amd64) TARGET=linux-x64 ;;
  Linux-aarch64|Linux-arm64) TARGET=linux-arm64 ;;
  *) echo "unsupported host: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

MANIFEST="$OUT/manifest-$TARGET.json"
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
sed -e "s|__PLATFORMS__|$TARGET file://$TARBALL $(field sha256) $(field size)|" \
  -e "s|__VERSION__|$(field version)|" \
  -e "s|__CHANNEL__|$(field channel)|" \
  "$ROOT/scripts/install.sh" | bash
