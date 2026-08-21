#!/bin/bash
set -euo pipefail

BINARY="${1:-$(dirname "$0")/../electron/electron}"

[ "$(uname -s)" = Linux ] || exit 0
[ -z "${TERMINAL_BROWSER_SKIP_APPARMOR:-}" ] || exit 0
[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || true)" = 1 ] || exit 0

if [ ! -x "$BINARY" ]; then
  echo "no electron binary at $BINARY" >&2
  exit 1
fi
BINARY="$(readlink -f "$BINARY")"

# When a setuid chrome-sandbox binary sits next to electron, chromium builds its
# sandbox with that root helper instead of user namespaces, so the profile this
# script writes would change nothing.
[ ! -u "$(dirname "$BINARY")/chrome-sandbox" ] || exit 0

# The kernel matches a profile against the path it actually executes, and one profile
# per binary lets a checkout and an installed copy each keep their own.
NAME="terminal-browser-$(printf '%s' "$BINARY" | sha256sum | cut -c1-12)"
PROFILE="/etc/apparmor.d/$NAME"

# Ubuntu 24.04 ships AppArmor 4.x (abi/4.0 only). Newer releases may have abi/5.0.
if [ -f /etc/apparmor.d/abi/5.0 ]; then
  ABI=5.0
elif [ -f /etc/apparmor.d/abi/4.0 ]; then
  ABI=4.0
else
  echo "no supported AppArmor abi under /etc/apparmor.d/abi/ - cannot install profile" >&2
  exit 1
fi

WANTED="abi <abi/${ABI}>,

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
if ! $SUDO apparmor_parser -r "$PROFILE"; then
  $SUDO rm -f "$PROFILE"
  echo "the kernel refused the profile, so it is gone and the next run will retry" >&2
  exit 1
fi
echo "AppArmor profile installed for $BINARY"
