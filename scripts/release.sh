#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-dev}"
OUT="$ROOT/dist-release"
STAGE="$OUT/pixel"

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
mkdir -p "$STAGE"/{bin,cli/dist,browser/dist,browser/native,electron,assets/fonts}

(cd "$ROOT/engine" && cargo build -p pixel-node --release)
cp "${CARGO_TARGET_DIR:-$ROOT/engine/target}/release/$NATIVE_LIBRARY" "$STAGE/browser/native/pixel.node"

ESBUILD="$ROOT/node_modules/.bin/esbuild"
bundle() {
  "$ESBUILD" "$1" \
    --bundle --platform=node --format=cjs \
    --external:electron '--external:*.node' \
    --alias:pixel-react="$ROOT/engine/packages/pixel-react/src/index.ts" \
    --alias:pixel-terminals="$ROOT/terminals/src/index.ts" \
    --alias:pixel-store="$ROOT/store/src/index.ts" \
    --define:process.env.NODE_ENV='"production"' \
    --sourcemap --outfile="$2" --log-level=warning
}
bundle "$ROOT/cli/src/main.ts" "$STAGE/cli/dist/main.js"
bundle "$ROOT/browser/src/main.tsx" "$STAGE/browser/dist/main.js"

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
    -c "Set :CFBundleIdentifier dev.zenbu.pixel" \
    "$APP/Contents/Info.plist" >/dev/null
  codesign --force --sign - --timestamp=none "$APP" 2>/dev/null
  ELECTRON_EXEC='electron/Pixel.app/Contents/MacOS/Pixel'
else
  cp -R "$ELECTRON_DIST"/. "$STAGE/electron/"
  ELECTRON_EXEC='electron/electron'
fi

sed "s|__ELECTRON_EXEC__|$ELECTRON_EXEC|" > "$STAGE/bin/pixel" <<'EOF'
#!/bin/sh
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
export PIXEL_DIST_ROOT="$ROOT"
export ELECTRON_RUN_AS_NODE=1
exec "$ROOT/__ELECTRON_EXEC__" "$ROOT/cli/dist/main.js" "$@"
EOF
chmod +x "$STAGE/bin/pixel"
echo "$VERSION" > "$STAGE/VERSION"
echo "$TARGET" > "$STAGE/TARGET"

TARBALL="$OUT/pixel-$TARGET.tar.gz"
tar -czf "$TARBALL" -C "$OUT" pixel

split -b 45m "$TARBALL" "$OUT/pixel-chunk-"
{
  if [ "$TARGET" = "darwin-arm64" ]; then
    shasum -a 256 "$TARBALL" | cut -d' ' -f1
  else
    sha256sum "$TARBALL" | cut -d' ' -f1
  fi
  (cd "$OUT" && ls pixel-chunk-*)
} > "$OUT/chunks.txt"

du -h "$TARBALL"
echo "chunks: $(cd "$OUT" && ls pixel-chunk-* | wc -l | tr -d ' ')"
