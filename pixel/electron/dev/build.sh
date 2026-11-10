#!/usr/bin/env bash

set -euo pipefail
source "$(dirname "$0")/common.sh"
require_e

e use "$CONFIG" >/dev/null
build_electron "$@"
echo "built app: $(built_app)"
