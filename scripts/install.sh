#!/bin/bash
set -euo pipefail

DOWNLOAD_URL="__DOWNLOAD_URL__"
VERSION="__VERSION__"
CHANNEL="__CHANNEL__"
SHA256="__SHA256__"
SIZE="__SIZE__"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "terminal-browser currently supports Apple Silicon macOS only" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

TARBALL="$TMP/terminal-browser.tar.gz"
echo "downloading terminal-browser $VERSION ($((SIZE / 1000000)) MB)"
curl -fL --retry 3 --retry-delay 2 --progress-bar "$DOWNLOAD_URL" -o "$TARBALL"

echo "$SHA256  $TARBALL" | shasum -a 256 -c - >/dev/null || {
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

SKILL_DIR="${AGENT_SKILLS_HOME:-$HOME/.agents/skills}/terminal-browser"
mkdir -p "$SKILL_DIR"
cp "$APP/skill/SKILL.md" "$SKILL_DIR/SKILL.md"

LINKED=""
for base in "$HOME/.claude" "$HOME/.codex" "$HOME/.cursor" "$HOME/.gemini"; do
  [ -d "$base/skills" ] || continue
  LINK="$base/skills/terminal-browser"
  if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then continue; fi
  ln -sfn "$SKILL_DIR" "$LINK"
  LINKED="$LINKED $(basename "$base")"
done

echo "installed terminal-browser $(cat "$APP/VERSION")${CHANNEL:+ ($CHANNEL)}"
echo "skill $SKILL_DIR${LINKED:+ (linked into$LINKED)}"

if [ -z "${TERMINAL_BROWSER_SKIP_EDITOR_SETUP:-}" ]; then
  "$APP/bin/terminal-browser" setup || true
fi
case ":$PATH:" in
  *":$BIN_HOME:"*) ;;
  *)
    echo
    echo "add $BIN_HOME to your PATH first:"
    echo "  echo 'export PATH=\"$BIN_HOME:\$PATH\"' >> ~/.zshrc && exec zsh"
    ;;
esac
echo
echo "  terminal-browser open example.com"
