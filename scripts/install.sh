#!/bin/bash
set -euo pipefail

VERSION="__VERSION__"
CHANNEL="__CHANNEL__"

PLATFORMS="__PLATFORMS__"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) TARGET=darwin-arm64 ;;
  Darwin-x86_64)
    if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then
      TARGET=darwin-arm64
    else
      TARGET=darwin-x64
    fi
    ;;
  Linux-x86_64|Linux-amd64) TARGET=linux-x64 ;;
  Linux-aarch64|Linux-arm64) TARGET=linux-arm64 ;;
  *)
    echo "terminal-browser does not support $(uname -s) $(uname -m)" >&2
    exit 1
    ;;
esac

ROW="$(printf '%s\n' "$PLATFORMS" | awk -v t="$TARGET" '$1 == t')"
if [ -z "$ROW" ]; then
  echo "terminal-browser $VERSION has no build for $TARGET" >&2
  exit 1
fi
read -r _ DOWNLOAD_URL SHA256 SIZE <<EOF
$ROW
EOF

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

TARBALL="$TMP/terminal-browser.tar.gz"
echo "downloading terminal-browser $VERSION ($((SIZE / 1000000)) MB)"
curl -fL --retry 3 --retry-delay 2 --progress-bar "$DOWNLOAD_URL" -o "$TARBALL"

if command -v sha256sum >/dev/null 2>&1; then
  CHECK="sha256sum -c -"
else
  CHECK="shasum -a 256 -c -"
fi
echo "$SHA256  $TARBALL" | $CHECK >/dev/null || {
  echo "download corrupted (checksum mismatch), try again" >&2
  exit 1
}

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
BIN_HOME="${XDG_BIN_HOME:-$HOME/.local/bin}"

APP="$DATA_HOME/terminal-browser/app"
if [ -d "$APP" ]; then
  echo "updating existing install (was $(cat "$APP/VERSION" 2>/dev/null || echo unknown))"
else
  echo "installing to $APP"
fi
rm -rf "$APP.new"
mkdir -p "$APP.new"
tar -xzf "$TARBALL" -C "$APP.new" --strip-components 1
pkill -f 'terminal-browser/app/browser/dist/main\.js' 2>/dev/null || true
rm -rf "$APP"
mv "$APP.new" "$APP"

mkdir -p "$BIN_HOME"
cat > "$BIN_HOME/terminal-browser" <<EOF
#!/bin/sh
exec "$APP/bin/terminal-browser" "\$@"
EOF
chmod +x "$BIN_HOME/terminal-browser"

if [ "$(uname -s)" = Linux ]; then
  missing="$(ldd "$APP/electron/electron" 2>/dev/null | awk '/not found/{print $1}' | sort -u)"
  if [ -n "$missing" ]; then
    echo "warning: missing system libraries:" >&2
    printf '  %s\n' $missing >&2
    echo "sudo apt-get install libnss3 libgtk-3-0 libasound2t64 libgbm1" >&2
  fi
fi

echo "installed terminal-browser $(cat "$APP/VERSION")${CHANNEL:+ ($CHANNEL)}"

if [ -z "${TERMINAL_BROWSER_SKIP_SETUP:-}" ]; then
  "$APP/bin/terminal-browser" setup || true
fi
case ":$PATH:" in
  *":$BIN_HOME:"*) ;;
  *)
    echo
    echo "add $BIN_HOME to your PATH first:"
    case "${SHELL:-}" in
      */zsh) echo "  echo 'export PATH=\"$BIN_HOME:\$PATH\"' >> ~/.zshrc && exec zsh" ;;
      */bash) echo "  echo 'export PATH=\"$BIN_HOME:\$PATH\"' >> ~/.bashrc && exec bash" ;;
      *) echo "  export PATH=\"$BIN_HOME:\$PATH\" (add it to your shell's rc file)" ;;
    esac
    ;;
esac
echo
echo "terminal-browser open terminal-browser.com"
