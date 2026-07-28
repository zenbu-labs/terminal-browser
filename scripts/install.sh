#!/bin/bash
set -euo pipefail

BASE_URL="__BASE_URL__"
TARGET="__TARGET__"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) HOST_TARGET="darwin-arm64" ;;
  Linux-aarch64|Linux-arm64) HOST_TARGET="linux-arm64" ;;
  Linux-x86_64|Linux-amd64) HOST_TARGET="linux-x64" ;;
  *)
    echo "pixel does not support $(uname -s) $(uname -m)" >&2
    exit 1
    ;;
esac

if [ "$HOST_TARGET" != "$TARGET" ]; then
  echo "this pixel build targets $TARGET, not $HOST_TARGET" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "downloading pixel..."
curl -fsSL --retry 3 "$BASE_URL/chunks.txt" -o "$TMP/chunks.txt"
SHA="$(head -1 "$TMP/chunks.txt")"
TARBALL="$TMP/pixel.tar.gz"
: > "$TARBALL"
tail -n +2 "$TMP/chunks.txt" | while read -r chunk; do
  [ -n "$chunk" ] || continue
  echo "  $chunk"
  curl -fsSL --retry 3 "$BASE_URL/$chunk" >> "$TARBALL"
done
if [ "$HOST_TARGET" = "darwin-arm64" ]; then
  ACTUAL_SHA="$(shasum -a 256 "$TARBALL" | cut -d' ' -f1)"
else
  ACTUAL_SHA="$(sha256sum "$TARBALL" | cut -d' ' -f1)"
fi
if [ "$ACTUAL_SHA" != "$SHA" ]; then
  echo "download corrupted (checksum mismatch), try again" >&2
  exit 1
fi

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
BIN_HOME="${XDG_BIN_HOME:-$HOME/.local/bin}"

APP="$DATA_HOME/pixel/app"
if [ -d "$APP" ]; then
  echo "updating existing install (was $(cat "$APP/VERSION" 2>/dev/null || echo unknown))"
else
  echo "installing to $APP"
fi
rm -rf "$APP.new"
mkdir -p "$APP.new"
tar -xzf "$TARBALL" -C "$APP.new" --strip-components 1
pkill -f 'pixel/app/browser/dist/main\.js' 2>/dev/null || true
rm -rf "$APP"
mv "$APP.new" "$APP"

mkdir -p "$BIN_HOME"
cat > "$BIN_HOME/pixel" <<EOF
#!/bin/sh
exec "$APP/bin/pixel" "\$@"
EOF
chmod +x "$BIN_HOME/pixel"

echo "installed pixel $(cat "$APP/VERSION")"
case ":$PATH:" in
  *":$BIN_HOME:"*) ;;
  *)
    echo
    echo "add $BIN_HOME to your PATH first (in your shell's rc file):"
    echo "  export PATH=\"$BIN_HOME:\$PATH\""
    ;;
esac
echo
echo "  pixel open example.com"
