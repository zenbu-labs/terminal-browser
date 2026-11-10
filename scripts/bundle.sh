#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

"$ROOT/node_modules/.bin/esbuild" "$1" \
  --bundle --platform=node --format=cjs \
  --external:electron '--external:*.node' \
  --alias:shared="$ROOT/shared/src/index.ts" \
  --define:process.env.NODE_ENV='"production"' \
  --sourcemap --outfile="$2" --log-level=warning

printf '{"type":"commonjs"}\n' > "$(dirname "$2")/package.json"
