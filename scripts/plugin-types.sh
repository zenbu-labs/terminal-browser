#!/bin/bash
set -euo pipefail

# .claude/types holds the plugin API declarations the plugin's tsconfig includes.
# They are gitignored and tied to the installed Claude Code, so we regenerate
# them here rather than checking them in. Claude Code unpacks them to a temp dir
# when its plugin-authoring skill loads.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/claude-code-plugin/.claude/types"

if [ "${1:-}" = "--if-missing" ] && [ -f "$DIR/claude-code.d.ts" ]; then
  exit 0
fi

if ! command -v claude >/dev/null 2>&1; then
  # fixme: placeholder copy
  echo "plugin-types: claude is not on PATH, skipping (run 'pnpm types' once it is installed)" >&2
  exit 0
fi

VERSION="$(claude --version | awk '{print $1}')"
claude -p "/plugin-authoring reply ok" --max-turns 1 </dev/null >/dev/null 2>&1 || true

SOURCE="$(ls -t /tmp/claude-"$(id -u)"/bundled-skills/"$VERSION"/*/plugin-authoring/types/claude-code.d.ts 2>/dev/null | head -n 1 || true)"
if [ -z "$SOURCE" ]; then
  # fixme: placeholder copy
  echo "plugin-types: claude $VERSION did not unpack the plugin types, skipping" >&2
  exit 0
fi

mkdir -p "$DIR"
cp "$SOURCE" "$DIR/claude-code.d.ts"
