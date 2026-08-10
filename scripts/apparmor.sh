#!/bin/bash
# Chromium sandboxes its renderers with unprivileged user namespaces. Ubuntu 24.04 and
# other AppArmor 4 distros hand that out only to programs named by an AppArmor profile,
# and only root may write one, so this asks for sudo when the profile is missing.
set -euo pipefail

BINARY="${1:-$(dirname "$0")/../electron/electron}"

[ "$(uname -s)" = Linux ] || exit 0
[ -z "${TERMINAL_BROWSER_SKIP_APPARMOR:-}" ] || exit 0
[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || true)" = 1 ] || exit 0

if [ ! -x "$BINARY" ]; then
  echo "no electron binary at $BINARY" >&2
  exit 1
fi
BINARY="$(cd "$(dirname "$BINARY")" && pwd -P)/$(basename "$BINARY")"

# a setuid-root helper is the other way to get a sandbox, and it needs no profile
[ ! -u "$(dirname "$BINARY")/chrome-sandbox" ] || exit 0

# The kernel matches a profile against the path it actually executes, and one profile
# per binary lets a checkout and an installed copy each keep their own.
NAME="terminal-browser-$(printf '%s' "$BINARY" | sha256sum | cut -c1-12)"
PROFILE="/etc/apparmor.d/$NAME"

WANTED="abi <abi/5.0>,

include <tunables/global>

@{exec_path} = $BINARY
profile $NAME @{exec_path} flags=(unconfined) {
  userns,
  @{exec_path} mr,

  include if exists <local/$NAME>
}"

[ "$(cat "$PROFILE" 2>/dev/null || true)" != "$WANTED" ] || exit 0

echo "chromium needs unprivileged user namespaces, which this system grants only to"
echo "programs with an AppArmor profile. writing one at $PROFILE"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
printf '%s\n' "$WANTED" > "$TMP"

SUDO=sudo
[ "$(id -u)" != 0 ] || SUDO=""
if [ -n "$SUDO" ] && ! command -v sudo >/dev/null 2>&1; then
  echo "no sudo here — copy $TMP to $PROFILE as root and run: apparmor_parser -r $PROFILE" >&2
  trap - EXIT
  exit 1
fi

$SUDO install -m 0644 -o root -g root "$TMP" "$PROFILE"
# The check at the top treats an existing profile as a finished job, so a profile the
# kernel never accepted has to go, or every later run skips the work it still needs.
if ! $SUDO apparmor_parser -r "$PROFILE"; then
  $SUDO rm -f "$PROFILE"
  echo "the kernel refused the profile, so it is gone and the next run will retry" >&2
  exit 1
fi
echo "AppArmor profile installed for $BINARY"
