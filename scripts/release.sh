#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-dev}"
CHANNEL="${2:-dev}"
OUT="$ROOT/dist-release"
STAGE="$OUT/terminal-browser"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) TARGET=darwin-arm64 ;;
  Linux-x86_64|Linux-amd64) TARGET=linux-x64 ;;
  Linux-aarch64|Linux-arm64) TARGET=linux-arm64 ;;
  *) echo "unsupported build host: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

rm -rf "$OUT"
mkdir -p "$STAGE"/{bin,cli/dist,browser/dist,browser/native,electron,agent-browser/bin,assets/fonts,scripts}

(cd "$ROOT/engine" && cargo build -p pixel-node --release)
if [ "$TARGET" = darwin-arm64 ]; then
  NATIVE_LIB=libpixel_node.dylib
else
  NATIVE_LIB=libpixel_node.so
fi
cp "${CARGO_TARGET_DIR:-$ROOT/engine/target}/release/$NATIVE_LIB" "$STAGE/browser/native/pixel.node"

# the engine bakes in a path to its build directory, which only exists on this machine
if [ "$TARGET" = darwin-arm64 ]; then
  swiftc -O "$ROOT/engine/crates/pixel-core/native-scroll-helper.swift" \
    -o "$STAGE/bin/native-scroll-helper"
  codesign --force --sign - --timestamp=none "$STAGE/bin/native-scroll-helper" 2>/dev/null || true
fi

AGENT_BROWSER_BIN="$("$ROOT/scripts/agent-browser.sh" --path)"
cp "$AGENT_BROWSER_BIN" "$STAGE/agent-browser/bin/agent-browser"
if [ "$TARGET" = darwin-arm64 ]; then
  codesign --force --sign - --timestamp=none "$STAGE/agent-browser/bin/agent-browser" 2>/dev/null || true
fi

"$ROOT/scripts/bundle.sh" "$ROOT/cli/src/main.ts" "$STAGE/cli/dist/main.js"
"$ROOT/scripts/bundle.sh" "$ROOT/browser/src/main.tsx" "$STAGE/browser/dist/main.js"

cp "$ROOT/scripts/apparmor.sh" "$STAGE/scripts/apparmor.sh"

"$ROOT/scripts/generate-skill.sh"
cp -R "$ROOT/skill/build" "$STAGE/skills"

cp "$ROOT/assets/fonts/JetBrainsMono-Regular.ttf" "$STAGE/assets/fonts/"

ELECTRON_DIST="$(node -e 'const p=require("path");console.log(p.join(p.dirname(require.resolve("electron/package.json",{paths:[process.argv[1]]})),"dist"))' "$ROOT/browser")"
if [ ! -f "$ELECTRON_DIST/.zenbu-electron-sha256" ]; then
  echo "refusing to build: installed electron does not come from https://github.com/zenbu-labs/electron-releases" >&2
  exit 1
fi
if [ "$TARGET" = darwin-arm64 ]; then
  APP="$STAGE/electron/terminal-browser.app"
  ditto "$ELECTRON_DIST/Electron.app" "$APP"
  mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/terminal-browser"
  /usr/libexec/PlistBuddy \
    -c "Set :CFBundleExecutable terminal-browser" \
    -c "Set :CFBundleName terminal-browser" \
    -c "Set :CFBundleDisplayName terminal-browser" \
    -c "Set :CFBundleIdentifier dev.zenbu.terminal-browser" \
    "$APP/Contents/Info.plist" >/dev/null
  codesign --force --sign - --timestamp=none "$APP" 2>/dev/null
  ELECTRON_EXE="electron/terminal-browser.app/Contents/MacOS/terminal-browser"
  NATIVE_SCROLL='export NATIVE_SCROLL_HELPER="$ROOT/bin/native-scroll-helper"'
else
  cp -a "$ELECTRON_DIST/." "$STAGE/electron/"
  ELECTRON_EXE="electron/electron"
  NATIVE_SCROLL=""
fi

cat > "$STAGE/bin/terminal-browser" <<EOF
#!/bin/sh
ROOT="\$(CDPATH= cd -- "\$(dirname -- "\$0")/.." && pwd -P)"
export TERMINAL_BROWSER_DIST_ROOT="\$ROOT"
export ELECTRON_RUN_AS_NODE=1
$NATIVE_SCROLL
exec "\$ROOT/$ELECTRON_EXE" "\$ROOT/cli/dist/main.js" "\$@"
EOF
chmod +x "$STAGE/bin/terminal-browser"
echo "$VERSION" > "$STAGE/VERSION"
echo "$CHANNEL" > "$STAGE/CHANNEL"

TARBALL="$OUT/terminal-browser-$TARGET.tar.gz"
tar -czf "$TARBALL" -C "$OUT" terminal-browser

if [ "$TARGET" = darwin-arm64 ]; then
  SHA256="$(shasum -a 256 "$TARBALL" | cut -d' ' -f1)"
  SIZE="$(stat -f%z "$TARBALL")"
else
  SHA256="$(sha256sum "$TARBALL" | cut -d' ' -f1)"
  SIZE="$(stat -c%s "$TARBALL")"
fi

cat > "$OUT/manifest-$TARGET.json" <<EOF
{
  "version": "$VERSION",
  "channel": "$CHANNEL",
  "platform": "$TARGET",
  "file": "$(basename "$TARBALL")",
  "sha256": "$SHA256",
  "size": $SIZE,
  "published": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

du -h "$TARBALL"
