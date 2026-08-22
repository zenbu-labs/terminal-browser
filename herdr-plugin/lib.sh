# Shared by the plugin's scripts. Sourced, never executed.

# Prints the terminal-browser binary to use, or fails if there is none. A checkout being
# worked on can point TERMINAL_BROWSER_BIN at its own build without installing over the
# copy on PATH, and every script here has to agree on that answer: picking a browser to
# reuse with one build and opening panes with another reuses the wrong registry.
tb_bin() {
  if [ -n "${TERMINAL_BROWSER_BIN:-}" ]; then
    # An override that resolves to nothing runnable is a stale answer, not a browser.
    # Say so instead of handing the caller a path that dies as a shell error later.
    command -v "$TERMINAL_BROWSER_BIN" >/dev/null 2>&1 || return 1
    printf '%s\n' "$TERMINAL_BROWSER_BIN"
    return 0
  fi
  if command -v terminal-browser >/dev/null 2>&1; then
    printf 'terminal-browser\n'
    return 0
  fi
  return 1
}

tb_missing_message() {
  if [ -n "${TERMINAL_BROWSER_BIN:-}" ]; then
    echo "TERMINAL_BROWSER_BIN is set to '$TERMINAL_BROWSER_BIN', which is not runnable — fix or unset it" >&2
    return 0
  fi
  echo "terminal-browser is not installed — see https://github.com/zenbu-labs/terminal-browser" >&2
}
