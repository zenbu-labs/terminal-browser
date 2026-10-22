#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-dev}"
CHANNEL="${2:-dev}"
OUT="$ROOT/dist-release"
STAGE="$OUT/terminal-browser"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) TARGET=darwin-arm64; DARWIN_ARCH=arm64 ;;
  Darwin-x86_64) TARGET=darwin-x64; DARWIN_ARCH=x86_64 ;;
  Linux-x86_64|Linux-amd64) TARGET=linux-x64; DARWIN_ARCH= ;;
  Linux-aarch64|Linux-arm64) TARGET=linux-arm64; DARWIN_ARCH= ;;
  *) echo "unsupported build host: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

rm -rf "$OUT"
mkdir -p "$STAGE"/{bin,cli/dist,browser/dist,browser/node_modules/@zenbu-labs,electron,agent-browser/bin,assets/fonts,scripts}

# pixel resolves its engine binary and scroll helper from this package at runtime;
# both come from the pixel/ workspace packages, built by pixel:build:native
NATIVE_PKG="$(node -e '
  const lib = require.resolve("@zenbu-labs/pixel/package.json", { paths: [process.argv[1]] });
  const pkg = require.resolve(`@zenbu-labs/pixel-native-${process.argv[2]}/package.json`, { paths: [require("path").dirname(lib)] });
  process.stdout.write(require("fs").realpathSync(require("path").dirname(pkg)));
' "$ROOT/browser" "$TARGET" 2>/dev/null || true)"
if [ -z "$NATIVE_PKG" ] || [ ! -f "$NATIVE_PKG/pixel.node" ]; then
  echo "refusing to build: @zenbu-labs/pixel-native-$TARGET has no pixel.node; run pnpm --filter @zenbu-labs/pixel build:native -- --release" >&2
  exit 1
fi
cp -RL "$NATIVE_PKG" "$STAGE/browser/node_modules/@zenbu-labs/pixel-native-$TARGET"
if [ -n "$DARWIN_ARCH" ]; then
  cp "$NATIVE_PKG/native-scroll-helper" "$STAGE/bin/native-scroll-helper"
  rm -f "$STAGE/browser/node_modules/@zenbu-labs/pixel-native-$TARGET/native-scroll-helper"
fi

AGENT_BROWSER_BIN="$("$ROOT/scripts/agent-browser.sh" --path)"
cp "$AGENT_BROWSER_BIN" "$STAGE/agent-browser/bin/agent-browser"

"$ROOT/scripts/bundle.sh" "$ROOT/cli/src/main.ts" "$STAGE/cli/dist/main.js"
"$ROOT/scripts/bundle.sh" "$ROOT/browser/src/main.tsx" "$STAGE/browser/dist/main.js"

cp "$ROOT/scripts/apparmor.sh" "$STAGE/scripts/apparmor.sh"
cp "$ROOT/scripts/termux.sh" "$STAGE/scripts/termux.sh"

"$ROOT/scripts/generate-skill.sh"
cp -R "$ROOT/skill/build" "$STAGE/skills"

cp "$ROOT/assets/fonts/JetBrainsMono-Regular.ttf" "$STAGE/assets/fonts/"

"$ROOT/scripts/copy-react-grab.sh"
mkdir -p "$STAGE/assets/react-grab"
cp "$ROOT/assets/react-grab/"* "$STAGE/assets/react-grab/"

mkdir -p "$STAGE/assets/search"
cp "$ROOT/assets/search/"* "$STAGE/assets/search/"

mkdir -p "$STAGE/assets/chromium"
cp "$ROOT/assets/chromium/"* "$STAGE/assets/chromium/"

ELECTRON_DIST="$(node -e '
  const p = require("path");
  const lib = require.resolve("@zenbu-labs/pixel/package.json", { paths: [process.argv[1]] });
  console.log(p.join(p.dirname(lib), "electron", "dist"));
' "$ROOT/browser")"
if [ ! -f "$ELECTRON_DIST/.zenbu-electron-sha256" ]; then
  echo "refusing to build: pixel has not installed its patched electron (run pnpm install)" >&2
  exit 1
fi
FRAMEWORK_BINARY="$ELECTRON_DIST/Electron.app/Contents/Frameworks/Electron Framework.framework/Electron Framework"
if [ -n "$DARWIN_ARCH" ] && [ -e "$FRAMEWORK_BINARY" ] && [ ! -L "$FRAMEWORK_BINARY" ]; then
  echo "electron bundle lost its symlinks; re-extracting" >&2
  rm -rf "$ELECTRON_DIST"
  node "$(dirname "$ELECTRON_DIST")/../scripts/postinstall.mjs"
  if [ ! -L "$FRAMEWORK_BINARY" ]; then
    echo "refusing to build: electron framework is still not a proper bundle after re-extraction" >&2
    exit 1
  fi
fi
if [ -n "$DARWIN_ARCH" ]; then
  APP="$STAGE/electron/terminal-browser.app"
  ditto "$ELECTRON_DIST/Electron.app" "$APP"
  mv "$APP/Contents/MacOS/pixel" "$APP/Contents/MacOS/terminal-browser"
  /usr/libexec/PlistBuddy \
    -c "Set :CFBundleExecutable terminal-browser" \
    -c "Set :CFBundleName terminal-browser" \
    -c "Set :CFBundleDisplayName terminal-browser" \
    -c "Set :CFBundleIdentifier dev.zenbu.terminal-browser" \
    "$APP/Contents/Info.plist" >/dev/null
  ELECTRON_EXE="electron/terminal-browser.app/Contents/MacOS/terminal-browser"
  NATIVE_SCROLL='export NATIVE_SCROLL_HELPER="${NATIVE_SCROLL_HELPER:-$ROOT/bin/native-scroll-helper}"'
  FUSE_TARGET="$APP"
else
  cp -a "$ELECTRON_DIST/." "$STAGE/electron/"
  ELECTRON_EXE="electron/pixel"
  NATIVE_SCROLL=""
  FUSE_TARGET="$STAGE/electron/pixel"
fi

TOOLS="$OUT/tools"
mkdir -p "$TOOLS"
[ -f "$TOOLS/package.json" ] || echo '{"private":true}' > "$TOOLS/package.json"
(cd "$TOOLS" && npm install --no-audit --no-fund --silent @electron/fuses@2.1.3)
FUSES="$TOOLS/node_modules/.bin/electron-fuses"
[ -x "$FUSES" ] || { echo "release.sh: @electron/fuses did not install" >&2; exit 1; }
NO_COLOR=1 "$FUSES" write --app "$FUSE_TARGET" EnableCookieEncryption=on
NO_COLOR=1 "$FUSES" read --app "$FUSE_TARGET" | sed $'s/\x1b\[[0-9;]*m//g' | tee "$OUT/fuses.txt"
grep -q "EnableCookieEncryption is Enabled" "$OUT/fuses.txt"
grep -q "RunAsNode is Enabled" "$OUT/fuses.txt"

cat > "$STAGE/bin/terminal-browser" <<EOF
#!/bin/sh
SELF="\$0"
while [ -L "\$SELF" ]; do
  LINK="\$(readlink "\$SELF")"
  case "\$LINK" in
    /*) SELF="\$LINK" ;;
    *) SELF="\$(dirname -- "\$SELF")/\$LINK" ;;
  esac
done
ROOT="\$(CDPATH= cd -- "\$(dirname -- "\$SELF")/.." && pwd -P)"
export TERMINAL_BROWSER_DIST_ROOT="\$ROOT"
export ELECTRON_RUN_AS_NODE=1
# Termux preloads an Android library that would stop electron, a glibc program, from starting
[ -n "\${TERMUX_VERSION:-}" ] && unset LD_PRELOAD
$NATIVE_SCROLL
exec "\$ROOT/$ELECTRON_EXE" "\$ROOT/cli/dist/main.js" "\$@"
EOF
chmod +x "$STAGE/bin/terminal-browser"
echo "$VERSION" > "$STAGE/VERSION"
echo "$CHANNEL" > "$STAGE/CHANNEL"

if [ -n "$DARWIN_ARCH" ]; then
  "$ROOT/scripts/macos-sign.sh" "$STAGE" "$CHANNEL"
fi

TARBALL="$OUT/terminal-browser-$TARGET.tar.gz"
tar -czf "$TARBALL" -C "$OUT" terminal-browser

if [ -n "$DARWIN_ARCH" ]; then
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
