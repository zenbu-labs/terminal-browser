#!/bin/bash
set -euo pipefail

VERSION="__VERSION__"
CHANNEL="__CHANNEL__"

# One "target url sha256 size" line per platform, filled in by the release worker.
PLATFORMS="__PLATFORMS__"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) TARGET=darwin-arm64 ;;
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
  bash "$APP/scripts/apparmor.sh" || echo "the browser will not start until that profile exists" >&2
fi

AGENT_SKILLS="${AGENT_SKILLS_HOME:-$HOME/.agents/skills}"
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
RECEIPT="$STATE_HOME/terminal-browser/skills.links"
WROTE="$(mktemp)"
trap 'rm -rf "$TMP" "$WROTE"' EXIT

link() {
  mkdir -p "$(dirname "$2")"
  ln -sfn "$1" "$2"
  printf '%s\n' "$2" >> "$WROTE"
}

LINKED=""
while read -r kind name location variant; do
  [ "$kind" = agent ] || continue
  DIR="$HOME/$location"
  [ -d "$(dirname "$DIR")" ] || continue
  mkdir -p "$DIR"
  MADE=""
  while read -r skind skill; do
    [ "$skind" = skill ] || continue
    TARGET="$APP/skills/${variant:-default}/$skill"
    [ -d "$TARGET" ] || continue
    LINK="$DIR/$skill"
    if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
      echo "leaving $LINK alone, it is not a link we made"
      continue
    fi
    link "$TARGET" "$LINK"
    MADE=1
  done < "$APP/skills/manifest"
  if [ -n "$MADE" ]; then LINKED="$LINKED $name"; fi
done < "$APP/skills/manifest"

while read -r kind skill; do
  [ "$kind" = skill ] || continue
  [ -d "$APP/skills/default/$skill" ] || continue
  SHARED="$AGENT_SKILLS/$skill"
  if [ -d "$SHARED" ] && [ ! -L "$SHARED" ]; then
    rm -f "$SHARED/SKILL.md"
    rmdir "$SHARED" 2>/dev/null || true
  fi
  if [ -e "$SHARED" ] && [ ! -L "$SHARED" ]; then
    echo "leaving $SHARED alone, it holds files we did not put there"
    continue
  fi
  link "$APP/skills/default/$skill" "$SHARED"
done < "$APP/skills/manifest"

if [ -f "$RECEIPT" ]; then
  while read -r stale; do
    [ -n "$stale" ] || continue
    grep -qxF "$stale" "$WROTE" && continue
    [ -L "$stale" ] || continue
    case "$(readlink "$stale")" in "$APP"/*) rm -f "$stale"; echo "removed $stale" ;; esac
  done < "$RECEIPT"
fi
mkdir -p "$(dirname "$RECEIPT")"
sort -u "$WROTE" > "$RECEIPT"

echo "installed terminal-browser $(cat "$APP/VERSION")${CHANNEL:+ ($CHANNEL)}"
echo "skills $AGENT_SKILLS${LINKED:+ (linked into$LINKED)}"

if [ -z "${TERMINAL_BROWSER_SKIP_EDITOR_SETUP:-}" ]; then
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
