#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-dev}"
CHANNEL="${2:-dev}"
OUT="$ROOT/dist-release"
STAGE="$OUT/terminal-browser"
APP="$STAGE/electron/Pixel.app"

rm -rf "$OUT"
mkdir -p "$STAGE"/{bin,cli/dist,browser/dist,browser/native,electron,agent-browser/bin,assets/fonts,skill}

(cd "$ROOT/engine" && cargo build -p pixel-node --release)
cp "${CARGO_TARGET_DIR:-$ROOT/engine/target}/release/libpixel_node.dylib" "$STAGE/browser/native/pixel.node"

AGENT_BROWSER_BIN="$("$ROOT/scripts/agent-browser.sh" --path)"
cp "$AGENT_BROWSER_BIN" "$STAGE/agent-browser/bin/agent-browser"
codesign --force --sign - --timestamp=none "$STAGE/agent-browser/bin/agent-browser" 2>/dev/null || true

"$ROOT/scripts/bundle.sh" "$ROOT/cli/src/main.ts" "$STAGE/cli/dist/main.js"
"$ROOT/scripts/bundle.sh" "$ROOT/browser/src/main.tsx" "$STAGE/browser/dist/main.js"

"$ROOT/scripts/generate-skill.sh"
cp "$ROOT/skill/SKILL.md" "$STAGE/skill/SKILL.md"

cp "$ROOT/assets/fonts/JetBrainsMono-Regular.ttf" "$STAGE/assets/fonts/"

ELECTRON_DIST="$(node -e 'const p=require("path");console.log(p.join(p.dirname(require.resolve("electron/package.json",{paths:[process.argv[1]]})),"dist"))' "$ROOT/browser")"
if [ ! -d "$ELECTRON_DIST/Electron.app" ]; then
  (cd "$(dirname "$ELECTRON_DIST")" && node install.js)
fi

if ! grep -qi "zenbu-labs" "$ROOT/.npmrc"; then
  echo "refusing to build: .npmrc no longer points at the patched electron mirror" >&2
  exit 1
fi


ditto "$ELECTRON_DIST/Electron.app" "$APP"
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/Pixel"
/usr/libexec/PlistBuddy \
  -c "Set :CFBundleExecutable Pixel" \
  -c "Set :CFBundleName Pixel" \
  -c "Set :CFBundleDisplayName Pixel" \
  -c "Set :CFBundleIdentifier dev.zenbu.terminal-browser" \
  "$APP/Contents/Info.plist" >/dev/null
codesign --force --sign - --timestamp=none "$APP" 2>/dev/null

cat > "$STAGE/bin/terminal-browser" <<'EOF'
#!/bin/sh
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
export TERMINAL_BROWSER_DIST_ROOT="$ROOT"
export ELECTRON_RUN_AS_NODE=1
exec "$ROOT/electron/Pixel.app/Contents/MacOS/Pixel" "$ROOT/cli/dist/main.js" "$@"
EOF
chmod +x "$STAGE/bin/terminal-browser"
echo "$VERSION" > "$STAGE/VERSION"

TARBALL="$OUT/terminal-browser-darwin-arm64.tar.gz"
tar -czf "$TARBALL" -C "$OUT" terminal-browser

cat > "$OUT/manifest.json" <<EOF
{
  "version": "$VERSION",
  "channel": "$CHANNEL",
  "platform": "darwin-arm64",
  "file": "$(basename "$TARBALL")",
  "sha256": "$(shasum -a 256 "$TARBALL" | cut -d' ' -f1)",
  "size": $(stat -f%z "$TARBALL"),
  "published": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

du -h "$TARBALL"
