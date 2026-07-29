#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/skill/SKILL.md"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

"$ROOT/scripts/bundle.sh" "$ROOT/cli/src/main.ts" "$TMP/cli.js"
"$ROOT/scripts/bundle.sh" "$ROOT/cli/src/help.ts" "$TMP/help.js"

# the commands come from help.ts so a new subcommand documents itself
COMMANDS="$(node -e 'process.stdout.write(require(process.argv[1]).helpTopics().join("\n"))' "$TMP/help.js")"

{
  cat "$ROOT/skill/SKILL.template.md"
  printf '\n```\n$ terminal-browser help\n'
  node "$TMP/cli.js" help
  printf '```\n'
  printf '%s\n' "$COMMANDS" | while IFS= read -r command; do
    [ -n "$command" ] || continue
    printf '\n```\n$ terminal-browser %s --help\n' "$command"
    node "$TMP/cli.js" "$command" --help
    printf '```\n'
  done
} > "$TMP/SKILL.md"

mv "$TMP/SKILL.md" "$OUT"
echo "wrote $OUT"
