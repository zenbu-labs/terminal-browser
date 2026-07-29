#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist-release"
MANIFEST="$OUT/manifest.json"
BUCKET="${R2_BUCKET:-terminal-browser-releases}"

[ -f "$MANIFEST" ] || { echo "no manifest at $MANIFEST — run release.sh first" >&2; exit 1; }

field() { node -p "require('$MANIFEST').$1"; }
VERSION="$(field version)"
CHANNEL="$(field channel)"
FILE="$(field file)"

wr() { (cd "$ROOT/release-worker" && npx --yes wrangler "$@"); }

# wrangler uploads in one request, which the API caps at 315 MB.
SIZE="$(field size)"
if [ "$SIZE" -gt 330000000 ]; then
  echo "tarball is ${SIZE} bytes — past the single-request R2 limit, needs multipart" >&2
  exit 1
fi

put() {
  wr r2 object put "$BUCKET/$1" --file "$2" --remote --content-type "$3" ${4:+--cache-control "$4"}
}

echo "uploading $FILE to $CHANNEL/$VERSION"
put "$CHANNEL/$VERSION/$FILE" "$OUT/$FILE" application/gzip
put "$CHANNEL/$VERSION/install.sh" "$ROOT/scripts/install.sh" text/x-shellscript
put "$CHANNEL/$VERSION/manifest.json" "$MANIFEST" application/json

# Flipped last so a failed upload never leaves the installer pointing at a
# version whose tarball is not there yet.
put "$CHANNEL/latest.json" "$MANIFEST" application/json no-store

echo "published $VERSION to $CHANNEL"
if [ -n "${RELEASE_ORIGIN:-}" ]; then
  if [ "$CHANNEL" = "stable" ]; then LATEST="$RELEASE_ORIGIN"; else LATEST="$RELEASE_ORIGIN/dev"; fi
  echo "pinned=$RELEASE_ORIGIN/v/$VERSION"
  echo "latest=$LATEST"
fi
