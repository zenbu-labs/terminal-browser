#!/bin/sh
set -eu
COMMIT=cec8b92f1ecd176a20a56aa405021e7ae991b996
here=$(cd "$(dirname "$0")/.." && pwd)
src=${GHOSTTY_SRC:-${XDG_CACHE_HOME:-$HOME/.cache}/pxsh/ghostty-$COMMIT}
zig=${ZIG:-zig}

if [ ! -d "$src/.git" ]; then
  mkdir -p "$src"
  git -C "$src" init -q
  git -C "$src" remote add origin https://github.com/ghostty-org/ghostty
  git -C "$src" fetch -q --depth 1 origin "$COMMIT"
  git -C "$src" checkout -q FETCH_HEAD
fi
[ "$(git -C "$src" rev-parse HEAD)" = "$COMMIT" ] || { echo "$src is not at $COMMIT" >&2; exit 1; }

(cd "$src" && "$zig" build -Demit-lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall)
cp "$src/zig-out/bin/ghostty-vt.wasm" "$here/vendor/ghostty-vt.wasm"
shasum -a 256 "$here/vendor/ghostty-vt.wasm"
