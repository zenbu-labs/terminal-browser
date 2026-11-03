#!/usr/bin/env bash
# gclient sync applies electron's own patch lists (patches/<dir>/.patches) before
# our series is in place, so the entries the series adds to any of those lists
# (chromium, devtools_frontend, v8, ...) have to be applied to their repos here.
set -euo pipefail

SRC="$(cd "${1:?usage: apply-added-patches.sh <chromium src dir> <electron ref the sync used>}" && pwd)"
BASE="${2:?usage: apply-added-patches.sh <chromium src dir> <electron ref the sync used>}"
ELECTRON="$SRC/electron"

node -e '
  for (const { patch_dir, repo } of require(process.argv[1])) {
    console.log(`${patch_dir.replace(/^src\/electron\/patches\//, "")}\t${repo.replace(/^src\/?/, "")}`);
  }
' "$ELECTRON/patches/config.json" | while IFS=$'\t' read -r dir repo; do
  list="$ELECTRON/patches/$dir/.patches"
  [ -f "$list" ] || continue
  base_list="$(git -C "$ELECTRON" show "$BASE:patches/$dir/.patches" 2>/dev/null || true)"
  for name in $(grep -vxF -e "" -f <(printf '%s\n' "$base_list") "$list" || true); do
    patch="$ELECTRON/patches/$dir/$name"
    if git -C "$SRC/$repo" apply --reverse --check "$patch" 2>/dev/null; then
      continue
    fi
    echo "applying $dir/$name"
    git -C "$SRC/$repo" apply "$patch"
  done
done
