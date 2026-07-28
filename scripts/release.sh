#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-dev}"
OUT="$ROOT/dist-release"
STAGE="$OUT/terminal-browser"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)
    TARGET="darwin-arm64"
    NATIVE_LIBRARY="libpixel_node.dylib"
    ;;
  Linux-aarch64|Linux-arm64)
    TARGET="linux-arm64"
    NATIVE_LIBRARY="libpixel_node.so"
    ;;
  Linux-x86_64|Linux-amd64)
    TARGET="linux-x64"
    NATIVE_LIBRARY="libpixel_node.so"
    ;;
  *)
    echo "unsupported release platform: $(uname -s) $(uname -m)" >&2
    exit 1
    ;;
esac

rm -rf "$OUT"
mkdir -p "$STAGE"/{bin,cli/dist,browser/dist,browser/native,electron,agent-browser/bin,assets/fonts,skill}

(cd "$ROOT/engine" && cargo build -p pixel-node --release)
cp "${CARGO_TARGET_DIR:-$ROOT/engine/target}/release/$NATIVE_LIBRARY" "$STAGE/browser/native/pixel.node"

AGENT_BROWSER_BIN="$("$ROOT/scripts/agent-browser.sh" --path)"
cp "$AGENT_BROWSER_BIN" "$STAGE/agent-browser/bin/agent-browser"
if [ "$TARGET" = "darwin-arm64" ]; then
  codesign --force --sign - --timestamp=none "$STAGE/agent-browser/bin/agent-browser" 2>/dev/null || true
fi

"$ROOT/scripts/bundle.sh" "$ROOT/cli/src/main.ts" "$STAGE/cli/dist/main.js"
"$ROOT/scripts/bundle.sh" "$ROOT/browser/src/main.tsx" "$STAGE/browser/dist/main.js"

"$ROOT/scripts/generate-skill.sh"
cp "$ROOT/skill/SKILL.md" "$STAGE/skill/SKILL.md"

cp "$ROOT/assets/fonts/JetBrainsMono-Regular.ttf" "$STAGE/assets/fonts/"

ELECTRON_DIST="$(node -e 'const p=require("path");console.log(p.join(p.dirname(require.resolve("electron/package.json",{paths:[process.argv[1]]})),"dist"))' "$ROOT/browser")"
pnpm --dir "$ROOT/browser" install:electron

if [ "$TARGET" = "darwin-arm64" ]; then
  APP="$STAGE/electron/Pixel.app"
  ditto "$ELECTRON_DIST/Electron.app" "$APP"
  mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/Pixel"
  /usr/libexec/PlistBuddy \
    -c "Set :CFBundleExecutable Pixel" \
    -c "Set :CFBundleName Pixel" \
    -c "Set :CFBundleDisplayName Pixel" \
    -c "Set :CFBundleIdentifier dev.zenbu.terminal-browser" \
    "$APP/Contents/Info.plist" >/dev/null
  codesign --force --sign - --timestamp=none "$APP" 2>/dev/null
  ELECTRON_EXEC='electron/Pixel.app/Contents/MacOS/Pixel'
else
  cp -R "$ELECTRON_DIST"/. "$STAGE/electron/"
  ELECTRON_EXEC='electron/electron'
fi

sed "s|__ELECTRON_EXEC__|$ELECTRON_EXEC|" > "$STAGE/bin/terminal-browser" <<'EOF'
#!/bin/sh
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
export TERMINAL_BROWSER_DIST_ROOT="$ROOT"
export ELECTRON_RUN_AS_NODE=1
exec "$ROOT/__ELECTRON_EXEC__" "$ROOT/cli/dist/main.js" "$@"
EOF
chmod +x "$STAGE/bin/terminal-browser"
echo "$VERSION" > "$STAGE/VERSION"
echo "$TARGET" > "$STAGE/TARGET"

TARBALL="$OUT/terminal-browser-$TARGET.tar.gz"
tar -czf "$TARBALL" -C "$OUT" terminal-browser

split -b 45m "$TARBALL" "$OUT/terminal-browser-chunk-"
{
  if [ "$TARGET" = "darwin-arm64" ]; then
    shasum -a 256 "$TARBALL" | cut -d' ' -f1
  else
    sha256sum "$TARBALL" | cut -d' ' -f1
  fi
  (cd "$OUT" && ls terminal-browser-chunk-*)
} > "$OUT/chunks.txt"

du -h "$TARBALL"
echo "chunks: $(cd "$OUT" && ls terminal-browser-chunk-* | wc -l | tr -d ' ')"
