#!/usr/bin/env bash

set -euo pipefail

DIST_ZIP="${1:?usage: finish.sh <dist.zip> <platform> <output dir> <work dir>}"
PLATFORM="${2:?usage: finish.sh <dist.zip> <platform> <output dir> <work dir>}"
OUT_DIR="${3:?usage: finish.sh <dist.zip> <platform> <output dir> <work dir>}"
WORK="${4:?usage: finish.sh <dist.zip> <platform> <output dir> <work dir>}"
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
DIST_ZIP="$(cd "$(dirname "$DIST_ZIP")" && pwd)/$(basename "$DIST_ZIP")"
mkdir -p "$OUT_DIR" "$WORK"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
WORK="$(cd "$WORK" && pwd)"

VERSION="$(unzip -p "$DIST_ZIP" version | tr -d '[:space:]')"
STAGE="$WORK/stage-$PLATFORM"
TOOLS="$WORK/tools"
rm -rf "$STAGE"
mkdir -p "$STAGE" "$TOOLS"
(cd "$STAGE" && unzip -q "$DIST_ZIP")
[ -f "$TOOLS/package.json" ] || echo '{"private":true}' > "$TOOLS/package.json"
(cd "$TOOLS" && npm install --no-audit --no-fund --silent @electron/fuses@2.1.3 @electron/osx-sign@1.3.3)
FUSES="$TOOLS/node_modules/.bin/electron-fuses"
[ -x "$FUSES" ] || { echo "finish.sh: @electron/fuses did not install" >&2; exit 1; }

case "$PLATFORM" in
  darwin-*)
    APP="$STAGE/Electron.app"
    /usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$APP/Contents/Info.plist" 2>/dev/null \
      || /usr/libexec/PlistBuddy -c "Set :LSUIElement true" "$APP/Contents/Info.plist"
    mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/pixel"
    /usr/libexec/PlistBuddy \
      -c "Set :CFBundleExecutable pixel" \
      -c "Set :CFBundleName pixel" \
      -c "Set :CFBundleDisplayName pixel" \
      -c "Set :CFBundleIdentifier dev.zenbu.pixel" \
      "$APP/Contents/Info.plist"
    FUSE_TARGET="$APP"
    ;;
  linux-*)
    mv "$STAGE/electron" "$STAGE/pixel"
    FUSE_TARGET="$STAGE/pixel"
    ;;
  *) echo "finish.sh: unknown platform $PLATFORM" >&2; exit 1 ;;
esac

echo "== fuses =="
NO_COLOR=1 "$FUSES" read --app "$FUSE_TARGET" | sed $'s/\x1b\[[0-9;]*m//g' | tee "$WORK/fuses.txt"
grep -q "RunAsNode is Enabled" "$WORK/fuses.txt"

case "$PLATFORM" in
  darwin-*)
    echo "== sign =="
    bash "$SCRIPTS/macos-sign.sh" "$APP" "$TOOLS"
    ;;
esac

echo "== zip =="
ASSET="electron-v$VERSION-$PLATFORM.zip"
rm -f "$OUT_DIR/$ASSET"
(cd "$STAGE" && zip -q -r -y -X "$OUT_DIR/$ASSET" .)
echo "$OUT_DIR/$ASSET"
