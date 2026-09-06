#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -e 'console.log(require(process.argv[1]+"/package.json").devDependencies.electron)' "$ROOT/browser")"
DEST="$(node -e 'const p=require("path");console.log(p.join(p.dirname(require.resolve("electron/package.json",{paths:[process.argv[1]]})),"dist"))' "$ROOT/browser")"

# the patched electron only adds the shared texture and shared memory paths,
# neither of which windows takes, so electron's own build is enough there
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    node "$(node -e 'console.log(require.resolve("electron/install.js",{paths:[process.argv[1]]}))' "$ROOT/browser")"
    exit 0
    ;;
esac

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLATFORM="darwin-arm64" ;;
  Darwin-x86_64) PLATFORM="darwin-x64" ;;
  Linux-x86_64) PLATFORM="linux-x64" ;;
  Linux-aarch64) PLATFORM="linux-arm64" ;;
  *) echo "fetch-electron: unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

MIRROR="https://github.com/zenbu-labs/electron-releases/releases/download/v$VERSION"
ZIP="electron-v$VERSION-$PLATFORM.zip"
MARKER="$DEST/.zenbu-electron-sha256"

expected="$(curl -fsL --retry 3 "$MIRROR/SHASUMS256.txt" | awk -v zip="*$ZIP" '$2 == zip {print $1}')"
if [ -z "$expected" ]; then
  echo "fetch-electron: $ZIP is missing from the mirror's SHASUMS256.txt" >&2
  exit 1
fi
if [ -f "$MARKER" ] && [ "$(cat "$MARKER")" = "$expected" ]; then
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "fetch-electron: downloading patched electron v$VERSION ($PLATFORM)" >&2
curl -fL --retry 3 --progress-bar "$MIRROR/$ZIP" -o "$TMP/$ZIP"
actual="$(shasum -a 256 "$TMP/$ZIP" | cut -d' ' -f1)"
if [ "$actual" != "$expected" ]; then
  echo "fetch-electron: $ZIP does not match the mirror's SHASUMS256.txt" >&2
  echo "  expected: $expected" >&2
  echo "  actual:   $actual" >&2
  exit 1
fi
unzip -q "$TMP/$ZIP" -d "$TMP/app"
stamped="$(cat "$TMP/app/version")"
if [ "$stamped" != "$VERSION" ]; then
  echo "fetch-electron: fetched electron stamps itself $stamped, expected $VERSION" >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
mv "$TMP/app" "$DEST"
echo "$expected" > "$MARKER"
echo "fetch-electron: installed patched electron v$VERSION into $DEST" >&2
