#!/bin/sh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
NODE_BIN="$(command -v node)"
mkdir -p "$BIN_DIR"

# INIT_CWD is unset so a pnpm-exported value never overrides the directory zed-pixel runs in.
cat > "$BIN_DIR/zed-pixel" <<LAUNCHER
#!/bin/sh
exec env -u INIT_CWD "$NODE_BIN" "$ROOT/dist/cli.js" "\$@"
LAUNCHER
chmod +x "$BIN_DIR/zed-pixel"
echo "$BIN_DIR/zed-pixel"
