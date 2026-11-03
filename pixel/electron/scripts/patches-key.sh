#!/usr/bin/env bash
# Prints a short key for "this Electron version with exactly these patches, built
# this way", so CI can find a patched build made from the same inputs.
set -euo pipefail
cd "$(dirname "$0")/.."
version="${1:-$(node -p 'require("../packages/pixel/package.json").config.electron')}"
{ echo "$version"; cat patches/*.patch scripts/build.sh scripts/apply-added-patches.sh; } | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-16
