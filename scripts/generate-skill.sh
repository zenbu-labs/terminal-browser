#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/skill/skills.json"
OUT="$ROOT/skill/build"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

"$ROOT/scripts/bundle.sh" "$ROOT/cli/src/main.ts" "$TMP/cli.js"
"$ROOT/scripts/bundle.sh" "$ROOT/cli/src/program.ts" "$TMP/program.js"

COMMANDS="$(node -e 'process.stdout.write(require(process.argv[1]).helpTopics().join("\n"))' "$TMP/program.js")"

{
  printf '\n```\n$ terminal-browser help\n'
  node "$TMP/cli.js" help
  printf '```\n'
  printf '%s\n' "$COMMANDS" | while IFS= read -r command; do
    [ -n "$command" ] || continue
    printf '\n```\n$ terminal-browser %s --help\n' "$command"
    node "$TMP/cli.js" "$command" --help
    printf '```\n'
  done
} > "$TMP/reference.md"

render() {
  awk -v overlay="$2" -v suffix="$3" '
    /^---$/ { dashes++ }
    dashes == 1 && /^description: / && suffix != "" { print $0 " " suffix; next }
    { print }
    dashes == 2 && /^---$/ && overlay != "" && !spliced {
      print ""
      while ((getline line < overlay) > 0) print line
      spliced = 1
    }
  ' "$1"
}

rm -rf "$OUT"
node -p "require('$MANIFEST').skills.map(s => s.name + ' ' + s.variants.join(',')).join('\n')" |
  while read -r name variants; do
    [ -n "$name" ] || continue
    for variant in ${variants//,/ }; do
      overlay="$ROOT/skill/$name/overlays/$variant.md"
      [ -f "$overlay" ] || overlay=""
      suffix=""
      if [ "$variant" != default ]; then
        suffix="If another $name skill is listed from a shared skills directory, use this one instead."
      fi
      mkdir -p "$OUT/$variant/$name"
      {
        render "$ROOT/skill/$name/SKILL.template.md" "$overlay" "$suffix"
        cat "$TMP/reference.md"
      } > "$OUT/$variant/$name/SKILL.md"
      echo "wrote $OUT/$variant/$name/SKILL.md"
    done
  done

node -e '
  const manifest = require(process.argv[1]);
  const lines = [
    ...manifest.agents.map((a) => `agent ${a.id} ${a.skills} ${a.variant ?? "default"}`),
    ...manifest.skills.map((s) => `skill ${s.name}`),
  ];
  process.stdout.write(lines.join("\n") + "\n");
' "$MANIFEST" > "$OUT/manifest"
