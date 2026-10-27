#!/usr/bin/env bash

set -euo pipefail
source "$(dirname "$0")/common.sh"
require_e

e use "$CONFIG" >/dev/null
SRC="$(electron_src)"
[ -d "$SRC/.git" ] || die "no electron checkout at $SRC; run dev/setup.sh first"

if [ -n "$(git -C "$SRC" status --porcelain)" ]; then
  die "the electron checkout has uncommitted changes; commit them as a patch first"
fi

commits="$(git -C "$SRC" rev-list --reverse "$TAG..$BRANCH")"
[ -n "$commits" ] || die "no commits on $BRANCH beyond $TAG"

say "writing patches from $BRANCH"
rm -f "$PATCHES_DIR"/*.patch
index=0
for commit in $commits; do
  index=$((index + 1))
  subject="$(git -C "$SRC" log -1 --format=%s "$commit")"
  slug="$(echo "$subject" | tr '[:upper:] ' '[:lower:]-' | tr -cd 'a-z0-9-')"
  [ -n "$slug" ] || die "commit $commit has an empty subject"
  # patches build on each other, so the file order (which is how build.sh applies them) must match commit order
  name="$(printf '%04d-%s' "$index" "$slug")"
  # blob hashes on index lines change with every export and git apply does not need them
  git -C "$SRC" diff "$commit^" "$commit" | grep -Ev "^index [0-9a-f.]+( [0-9]+)?$" > "$PATCHES_DIR/$name.patch"
  echo "$name.patch"
done

if [ "${1:-}" = "--check" ]; then
  bash "$ELECTRON_DIR/scripts/check-patches.sh" "$ELECTRON_VERSION"
fi
