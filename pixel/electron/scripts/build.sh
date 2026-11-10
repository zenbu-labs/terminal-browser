#!/usr/bin/env bash

set -euo pipefail

VERSION="${1:?usage: build.sh <electron version> <output dir> [platform]}"
OUT_DIR="${2:?usage: build.sh <electron version> <output dir> [platform]}"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) HOST="darwin-arm64"; GN_SUBDIR="mac" ;;
  Darwin-x86_64) HOST="darwin-x64"; GN_SUBDIR="mac" ;;
  Linux-x86_64) HOST="linux-x64"; GN_SUBDIR="linux64" ;;
  *) echo "build.sh: unsupported host $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
PLATFORM="${3:-$HOST}"

GN_TARGET_CPU=""
if [ "$PLATFORM" != "$HOST" ]; then
  case "$HOST/$PLATFORM" in
    darwin-arm64/darwin-x64) GN_TARGET_CPU=' target_cpu="x64"' ;;
    darwin-x64/darwin-arm64) GN_TARGET_CPU=' target_cpu="arm64"' ;;
    linux-x64/linux-arm64) GN_TARGET_CPU=' target_cpu="arm64"' ;;
    *) echo "build.sh: cannot build $PLATFORM on a $HOST host" >&2; exit 1 ;;
  esac
fi
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${ELECTRON_BUILD_DIR:-$HOME/.pixel-build}"
GN_BUILD_TYPE="${GN_BUILD_TYPE:-release}"
mkdir -p "$WORK" "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

echo "== disk before =="
df -h "$WORK" | tail -1

if [ ! -d "$WORK/depot_tools" ]; then
  git clone --depth 1 https://chromium.googlesource.com/chromium/tools/depot_tools.git "$WORK/depot_tools"
fi
export PATH="$WORK/depot_tools:$PATH"
export DEPOT_TOOLS_UPDATE=0
# build scripts shell out to `gn` from PATH; the depot_tools wrapper refuses
# to run until its pinned python is bootstrapped
if [ -x "$WORK/depot_tools/ensure_bootstrap" ]; then
  "$WORK/depot_tools/ensure_bootstrap"
fi

mkdir -p "$WORK/electron"
cd "$WORK/electron"
if [ ! -f .gclient ]; then
  gclient config --name "src/electron" --unmanaged https://github.com/electron/electron
fi

echo "== gclient sync v$VERSION =="
gclient sync -f --with_branch_heads --with_tags --no-history -j8 \
  --revision "src/electron@v$VERSION"

if [ "$HOST" = linux-x64 ] && [ "${SKIP_BUILD_DEPS:-0}" != "1" ]; then
  echo "== install chromium build deps =="
  # the runner image has shipped with a truncated package index before, which
  # makes every apt query fail; fetching the indexes fresh is the cure
  sudo rm -rf /var/lib/apt/lists/* /var/cache/apt/*.bin
  sudo apt-get update || true
  sudo "$WORK/electron/src/build/install-build-deps.sh" --no-prompt
fi
if ! command -v zip >/dev/null; then
  sudo apt-get install -y zip
fi

if [ "$PLATFORM" = linux-arm64 ]; then
  echo "== install arm64 sysroot =="
  python3 "$WORK/electron/src/build/linux/sysroot_scripts/install-sysroot.py" \
    --sysroots-json-path="$WORK/electron/src/electron/script/sysroots.json" \
    --arch=arm64
fi

echo "== apply patches =="
cd "$WORK/electron/src/electron"
git checkout -- .
for patch in "$REPO_DIR"/patches/*.patch; do
  echo "applying $(basename "$patch")"
  git apply "$patch"
done

echo "== typescript definitions =="
# electron generates its types from docs/api, so the patched docs yield types
# that describe the patched binary; the checkout's yarn install already ran
# as a gclient hook
node script/create-api-json.mjs
node node_modules/.bin/electron-typescript-definitions --api=electron-api.json --outDir=.
cp electron.d.ts "$OUT_DIR/electron.d.ts"

echo "== gn gen =="
cd "$WORK/electron/src"
# //electron/BUILD.gn lists .git/packed-refs as a gn input; a no-history
# checkout has no packed refs until we pack them
git -C electron pack-refs --all || true
[ -f electron/.git/packed-refs ] || touch electron/.git/packed-refs
export CHROMIUM_BUILDTOOLS_PATH="$PWD/buildtools"
# the checkout's own pinned binaries: the depot_tools gn/ninja wrappers
# require a bootstrapped depot_tools python that we deliberately skip
GN="$PWD/buildtools/$GN_SUBDIR/gn"
NINJA="$PWD/third_party/ninja/ninja"
# no-history checkouts have no git tags, so electron would stamp itself
# v0.0.0-no-git-tag-found without the explicit version override
BUILD="out/$PLATFORM"
"$GN" gen "$BUILD" --args="import(\"//electron/build/args/$GN_BUILD_TYPE.gn\") use_remoteexec=false override_electron_version=\"$VERSION\" enable_dsyms=false symbol_level=0$GN_TARGET_CPU"

echo "== ninja (this is the long part) =="
"$NINJA" -C "$BUILD" electron
"$NINJA" -C "$BUILD" electron:electron_dist_zip

if [ "$GN_SUBDIR" = mac ]; then
  WANT=x86_64; [ "$PLATFORM" = darwin-arm64 ] && WANT=arm64
  GOT="$(lipo -archs "$BUILD/Electron.app/Contents/MacOS/Electron")"
else
  WANT=x86-64; [ "$PLATFORM" = linux-arm64 ] && WANT=aarch64
  GOT="$(file -b "$BUILD/electron")"
fi
case "$GOT" in
  *"$WANT"*) ;;
  *)
    echo "build.sh: built a $GOT Electron but $PLATFORM needs $WANT" >&2
    exit 1
    ;;
esac

echo "== finish the app =="
bash "$REPO_DIR/scripts/finish.sh" "$PWD/$BUILD/dist.zip" "$PLATFORM" "$OUT_DIR" "$WORK/finish"
ASSET="electron-v$VERSION-$PLATFORM.zip"
cd "$OUT_DIR"
if command -v sha256sum >/dev/null; then
  sha256sum "$ASSET" electron.d.ts | awk '{print $1 " *" $2}' > SHASUMS256.txt
else
  shasum -a 256 "$ASSET" electron.d.ts | awk '{print $1 " *" $2}' > SHASUMS256.txt
fi

echo "== artifacts =="
ls -la "$OUT_DIR"
cat SHASUMS256.txt
