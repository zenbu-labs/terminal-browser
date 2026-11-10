#!/usr/bin/env bash


set -euo pipefail
source "$(dirname "$0")/common.sh"

case "$(uname -s)" in
  Darwin)
    xcode-select -p >/dev/null 2>&1 || die "Xcode is required; install it and run xcode-select --install"
    # Xcode 26 ships without the Metal compiler that ANGLE's shader targets need
    if ! xcrun -sdk macosx metal --version >/dev/null 2>&1; then
      say "installing the Xcode Metal toolchain"
      xcodebuild -downloadComponent MetalToolchain
    fi
    ;;
esac

say "electron $ELECTRON_VERSION into $ROOT"

if ! command -v e >/dev/null 2>&1; then
  say "installing @electron/build-tools"
  npm install -g @electron/build-tools
fi

if ! e show configs 2>/dev/null | sed $'s/\x1b\[[0-9;]*m//g' | grep -qE "^[* ] *$CONFIG\$"; then
  say "creating build config $CONFIG"
  e init "$CONFIG" --root "$ROOT" -i testing -o Testing --remote-build none --use-https
fi
e use "$CONFIG" >/dev/null

SRC="$ROOT/src/electron"
if [ ! -d "$SRC/.git" ]; then
  say "fetching electron $TAG and its chromium (30 GB or so, no history)"
  e sync --no-history --revision "src/electron@$TAG"
else
  say "source already present, syncing"
  e sync --no-history
fi

if ! git -C "$SRC" rev-parse --verify --quiet "$TAG" >/dev/null; then
  git -C "$SRC" fetch --depth 1 origin "refs/tags/$TAG:refs/tags/$TAG"
fi

if git -C "$SRC" rev-parse --verify --quiet "$BRANCH" >/dev/null; then
  say "branch $BRANCH exists, checking it out"
  git -C "$SRC" checkout -q "$BRANCH"
else
  say "creating $BRANCH from $TAG with one commit per patch"
  git -C "$SRC" checkout -q -B "$BRANCH" "$TAG"
  for patch in "$PATCHES_DIR"/*.patch; do
    name="$(basename "$patch" .patch)"
    name="${name#[0-9][0-9][0-9][0-9]-}"
    echo "applying $name"
    git -C "$SRC" apply --index "$patch"
    git -C "$SRC" -c user.name=pixel -c user.email=pixel@zenbu.dev commit -q -m "$name"
  done
fi

# gn derives the version from .git/packed-refs, which a history-less clone never writes
git -C "$SRC" pack-refs --all

say "building (the first time takes about an hour on an M-series Max)"
build_electron

say "done"
echo "built app: $(built_app)"
echo "run the browser against it with:"
echo "  PIXEL_ELECTRON_APP=\"$(built_app)\" nr browser"
