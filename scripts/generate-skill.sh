#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/skill/SKILL.md"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

"$ROOT/scripts/bundle.sh" "$ROOT/cli/src/main.ts" "$TMP/cli.js"

{
  cat "$ROOT/skill/SKILL.template.md"
  for command in "help" "open --help" "ls --help" "action --help"; do
    printf '\n```\n$ terminal-browser %s\n' "$command"
    node "$TMP/cli.js" $command
    printf '```\n'
  done
} > "$TMP/SKILL.md"

mv "$TMP/SKILL.md" "$OUT"
echo "wrote $OUT"
