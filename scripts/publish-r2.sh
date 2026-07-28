#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist-release"
MANIFEST="$OUT/manifest.json"

: "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID}"
: "${R2_ACCESS_KEY_ID:?set R2_ACCESS_KEY_ID}"
: "${R2_SECRET_ACCESS_KEY:?set R2_SECRET_ACCESS_KEY}"
BUCKET="${R2_BUCKET:-terminal-browser-releases}"

[ -f "$MANIFEST" ] || { echo "no manifest at $MANIFEST — run release.sh first" >&2; exit 1; }

field() { node -p "require('$MANIFEST').$1"; }
VERSION="$(field version)"
CHANNEL="$(field channel)"
FILE="$(field file)"

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION=auto
# Newer aws-cli appends CRC32 trailers that R2 rejects on multipart uploads.
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required

ENDPOINT="https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
put() { aws s3 cp --endpoint-url "$ENDPOINT" --only-show-errors "$@"; }

PREFIX="s3://$BUCKET/$CHANNEL/$VERSION"

echo "uploading $FILE to $CHANNEL/$VERSION"
put "$OUT/$FILE" "$PREFIX/$FILE" --content-type application/gzip
put "$MANIFEST" "$PREFIX/manifest.json" --content-type application/json

# Flipped last so a failed upload never leaves the installer pointing at a
# version whose tarball is not there yet.
put "$MANIFEST" "s3://$BUCKET/$CHANNEL/latest.json" \
  --content-type application/json --cache-control no-store

echo "published $VERSION to $CHANNEL"
if [ -n "${RELEASE_ORIGIN:-}" ]; then
  PINNED="$RELEASE_ORIGIN/v/$VERSION"
  if [ "$CHANNEL" = "stable" ]; then LATEST="$RELEASE_ORIGIN"; else LATEST="$RELEASE_ORIGIN/dev"; fi
  echo "pinned=$PINNED"
  echo "latest=$LATEST"
fi
