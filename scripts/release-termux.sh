#!/data/data/com.termux/files/usr/bin/bash
# Builds a Termux release on the phone and publishes it to this fork's GitHub releases.
# Electron, agent-browser and the assets come from the matching upstream linux-arm64 release;
# the native engine, the bundled JavaScript and the launcher are replaced with this fork's.
set -euo pipefail

VERSION="${1:?usage: release-termux.sh <version, e.g. v0.13.4-termux.1>}"
BASE="${VERSION%-termux.*}"
[ "$BASE" != "$VERSION" ] || { echo "version must look like <upstream version>-termux.<n>" >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="${TERMINAL_BROWSER_REPO:-RchrdAriza/terminal-browser-termux}"
UPSTREAM="https://terminal-browser.sh/install"
TARGET=linux-arm64
OUT="$ROOT/dist-release"
STAGE="$OUT/terminal-browser"
TARBALL="$OUT/terminal-browser-$TARGET.tar.gz"
DOWNLOADS="https://github.com/$REPO/releases/download/$VERSION"
GLIBC="$PREFIX/glibc"

if ! git -C "$ROOT" diff --quiet || ! git -C "$ROOT" diff --cached --quiet; then
  echo "working tree is dirty — commit or stash first" >&2
  exit 1
fi
BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
git -C "$ROOT" fetch -q origin "$BRANCH"
if [ "$(git -C "$ROOT" rev-parse HEAD)" != "$(git -C "$ROOT" rev-parse "origin/$BRANCH")" ]; then
  echo "$BRANCH is out of sync with origin — push or pull first" >&2
  exit 1
fi

echo "building the native engine"
(
  cd "$ROOT/pixel/engine"
  export RUSTUP_HOME="$HOME/.local/share/glibc-rust/rustup" CARGO_HOME="$HOME/.local/share/glibc-rust/cargo"
  export PATH="$CARGO_HOME/bin:$PATH"
  # without -B the compilers find Termux's Android linker before the glibc one
  export CC="$GLIBC/bin/gcc" CXX="$GLIBC/bin/g++" CFLAGS="-B$GLIBC/bin" CXXFLAGS="-B$GLIBC/bin"
  export RUSTFLAGS="-C linker=$GLIBC/bin/gcc -C link-arg=-B$GLIBC/bin"
  env -u LD_PRELOAD cargo build -p pixel-node --release
)

rm -rf "$OUT"
mkdir -p "$OUT"

ROW="$(curl -fsSL "$UPSTREAM/v/$BASE" | awk -v t="$TARGET" '{ sub(/^PLATFORMS="/, "") } $1 == t')"
[ -n "$ROW" ] || { echo "upstream $BASE has no $TARGET build" >&2; exit 1; }
read -r _ BASE_URL BASE_SHA256 _ <<EOF
$ROW
EOF
echo "downloading upstream $BASE"
curl -fL --retry 3 --progress-bar "$BASE_URL" -o "$OUT/upstream.tar.gz"
echo "$BASE_SHA256  $OUT/upstream.tar.gz" | sha256sum -c - >/dev/null
tar -xzf "$OUT/upstream.tar.gz" -C "$OUT"
rm "$OUT/upstream.tar.gz"

cp "$ROOT/pixel/engine/target/release/libpixel_node.so" "$STAGE/browser/node_modules/@zenbu-labs/pixel-native-$TARGET/pixel.node"
bash "$ROOT/scripts/bundle.sh" "$ROOT/cli/src/main.ts" "$STAGE/cli/dist/main.js"
bash "$ROOT/scripts/bundle.sh" "$ROOT/browser/src/main.tsx" "$STAGE/browser/dist/main.js"
cp "$ROOT/scripts/termux.sh" "$STAGE/scripts/termux.sh"
if ! grep -q LD_PRELOAD "$STAGE/bin/terminal-browser"; then
  sed -i '/^exec /i [ -n "${TERMUX_VERSION:-}" ] \&\& unset LD_PRELOAD' "$STAGE/bin/terminal-browser"
fi
echo "$VERSION" > "$STAGE/VERSION"
echo stable > "$STAGE/CHANNEL"

tar -czf "$TARBALL" -C "$OUT" terminal-browser
SHA256="$(sha256sum "$TARBALL" | cut -d' ' -f1)"
SIZE="$(stat -c%s "$TARBALL")"

sed -e "s|__PLATFORMS__|$TARGET $DOWNLOADS/$(basename "$TARBALL") $SHA256 $SIZE|" \
  -e "s|__VERSION__|$VERSION|" \
  -e "s|__CHANNEL__|stable|" \
  "$ROOT/scripts/install.sh" > "$OUT/install.sh"
printf '{\n  "version": "%s",\n  "install": "%s"\n}\n' "$VERSION" "$DOWNLOADS/install.sh" > "$OUT/latest.json"

du -h "$TARBALL"
gh release create "$VERSION" -R "$REPO" --target "$(git -C "$ROOT" rev-parse HEAD)" \
  --title "terminal-browser $VERSION" \
  --notes "curl -fsSL https://github.com/$REPO/releases/latest/download/install.sh | bash" \
  "$TARBALL" "$OUT/install.sh" "$OUT/latest.json"
