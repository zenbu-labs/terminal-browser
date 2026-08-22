#!/usr/bin/env bash
# The build step of `herdr plugin install`. Every entrypoint in this plugin is a wrapper
# around the terminal-browser binary, so installing the plugin onto a machine that has no
# browser yields a plugin that errors on the first click — the one thing the person who
# just installed it will do.
set -euo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# A browser that is already here is the one the operator wants, whether it came from a
# release or from their own checkout. Installing over it is how a plugin install quietly
# replaces the build somebody is working on. A stale TERMINAL_BROWSER_BIN is no reason to
# install over the copy on PATH, so this asks about both.
if bin="$(tb_bin)" || bin="$(command -v terminal-browser)"; then
  echo "terminal-browser is already installed ($bin), leaving it alone"
  exit 0
fi

echo "installing terminal-browser, which this plugin runs"
curl -fsSL https://terminal-browser.sh/install | bash
