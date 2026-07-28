#!/bin/bash
set -euo pipefail

INSTALLER_GIST="c2ec553bd3a1faadfcb9e3f204b1d39c"
DESCRIPTION_PREFIX="terminal-browser build"
KEEP=10

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist-release"
VERSION="$(cat "$OUT/terminal-browser/VERSION")"
TARGET="$(cat "$OUT/terminal-browser/TARGET")"
OWNER="$(gh api user --jq .login)"

BUILD_URL="$(gh gist create -d "$DESCRIPTION_PREFIX $VERSION $TARGET" -f chunks.txt "$OUT/chunks.txt")"
BUILD_ID="${BUILD_URL##*/}"

installer_for() {
  sed \
    -e "s|__BASE_URL__|https://gist.githubusercontent.com/$OWNER/$1/raw|" \
    -e "s|__TARGET__|$TARGET|" \
    "$ROOT/scripts/install.sh"
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git clone -q "https://x-access-token:$(gh auth token)@gist.github.com/$BUILD_ID.git" "$WORK/build"
cp "$OUT"/terminal-browser-chunk-* "$WORK/build/"
installer_for "$BUILD_ID" > "$WORK/build/install.sh"
git -C "$WORK/build" add -A
git -C "$WORK/build" \
  -c user.name="terminal-browser release" -c user.email="release@zenbu.dev" \
  commit -q -m "terminal-browser $VERSION"
git -C "$WORK/build" push -q origin HEAD

installer_for "$BUILD_ID" > "$WORK/install.sh"
gh api "gists/$INSTALLER_GIST" -X PATCH \
  -F "files[install.sh][content]=@$WORK/install.sh" --jq '.updated_at' >/dev/null

gh api --paginate '/gists?per_page=100' \
  --jq ".[] | select(.description | startswith(\"$DESCRIPTION_PREFIX \")) | [.created_at, .id] | @tsv" \
  | sort -r | tail -n +$((KEEP + 1)) | cut -f2 | while read -r stale; do
  gh api -X DELETE "gists/$stale" >/dev/null && echo "pruned $stale"
done

PINNED="https://gist.githubusercontent.com/$OWNER/$BUILD_ID/raw/install.sh"
LATEST="https://gist.githubusercontent.com/$OWNER/$INSTALLER_GIST/raw/install.sh"
echo "published $VERSION"
echo "pinned=$PINNED"
echo "latest=$LATEST"
