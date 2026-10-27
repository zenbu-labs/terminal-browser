# shellcheck shell=bash

DEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="$(dirname "$DEV_DIR")"
PATCHES_DIR="$ELECTRON_DIR/patches"
PIXEL_PACKAGE="$ELECTRON_DIR/../packages/pixel/package.json"

# PIXEL_ELECTRON_VERSION targets a version ahead of the pinned one, for rebasing patches before a release exists
ELECTRON_VERSION="${PIXEL_ELECTRON_VERSION:-$(node -p "require('$PIXEL_PACKAGE').config.electron")}"
ROOT="${PIXEL_ELECTRON_DEV_ROOT:-$HOME/electron-dev}"
CONFIG="pixel-dev"
BRANCH="pixel/v$ELECTRON_VERSION"
TAG="v$ELECTRON_VERSION"

say() { printf '\033[1m== %s ==\033[0m\n' "$*"; }
die() { echo "$(basename "$0"): $*" >&2; exit 1; }

require_e() {
  command -v e >/dev/null 2>&1 || die "electron build-tools are not installed; run dev/setup.sh first"
}

electron_src() {
  e show src
}

built_app() {
  local exe
  exe="$(e show exe)"
  case "$(uname -s)" in
    Darwin) echo "${exe%/Contents/MacOS/*}" ;;
    *) echo "$exe" ;;
  esac
}

# autoninja runs one compiler per core, and blink's translation units take 3 to 4 GB each,
# which exhausts a laptop's memory; derive a cap from memory unless the caller passes -j
default_jobs() {
  local mem_gb cores
  case "$(uname -s)" in
    Darwin) mem_gb=$(( $(sysctl -n hw.memsize) / 1073741824 )); cores=$(sysctl -n hw.ncpu) ;;
    *) mem_gb=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1048576 )); cores=$(nproc) ;;
  esac
  local jobs=$(( mem_gb / 6 ))
  [ "$jobs" -gt "$cores" ] && jobs=$cores
  [ "$jobs" -lt 2 ] && jobs=2
  echo "${PIXEL_ELECTRON_JOBS:-$jobs}"
}

build_electron() {
  case " $* " in
    *" -j"*) e build "$@" ;;
    *) e build -j "$(default_jobs)" "$@" ;;
  esac
}
