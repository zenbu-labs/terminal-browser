#!/data/data/com.termux/files/usr/bin/bash
# Makes an installed terminal-browser run on Termux: electron is built against glibc, so it runs
# through Termux's glibc loader, with libraries the glibc repo lacks taken from Ubuntu.
set -euo pipefail

APP="${1:-${XDG_DATA_HOME:-$HOME/.local/share}/terminal-browser/app}"
UBUNTU_ROOT="${TERMINAL_BROWSER_UBUNTU_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/terminal-browser-ubuntu}"
UBUNTU_MIRROR="http://ports.ubuntu.com/ubuntu-ports"
UBUNTU_SUITES="noble-updates noble-security noble"
GLIBC="$PREFIX/glibc"

GLIBC_PACKAGES=(
  glibc-repo glibc patchelf-glibc
  glib-glibc libcairo-glibc pango-glibc harfbuzz-glibc freetype-glibc fontconfig-glibc ttf-dejavu-glibc
  libx11-glibc libxcomposite-glibc libxext-glibc libxfixes-glibc libxrandr-glibc libxcb-glibc
  libxkbcommon-glibc libxcursor-glibc libxi-glibc libxinerama-glibc libepoxy-glibc
  alsa-lib-glibc dbus-glibc libexpat-glibc mesa-glibc libdrm-glibc gnutls-glibc libsqlite-glibc
)

UBUNTU_PACKAGES=(
  libgtk-3-0t64 libgdk-pixbuf-2.0-0 libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64
  libcups2t64 libavahi-client3 libavahi-common3 libnss3 libnspr4 libudev1 libxdamage1
  libjpeg8 libjpeg-turbo8 libxml2 libicu74
  libpulse0 libsndfile1 libasyncns0 libapparmor1 libsystemd0 libgcrypt20 libgpg-error0
  libflac12t64 libvorbis0a libvorbisenc2 libogg0 libopus0 libmpg123-0t64 libmp3lame0
)

if [ -z "${TERMUX_VERSION:-}" ] && [[ "${PREFIX:-}" != /data/data/com.termux/* ]]; then
  echo "this script only makes sense inside Termux" >&2
  exit 1
fi
if [ ! -x "$APP/electron/pixel" ]; then
  echo "no terminal-browser install at $APP" >&2
  exit 1
fi

if [ ! -f "$PREFIX/etc/apt/sources.list.d/glibc.list" ]; then
  pkg install -y glibc-repo
fi
pkg install -y "${GLIBC_PACKAGES[@]}" pulseaudio

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for suite in $UBUNTU_SUITES; do
  for component in main universe; do
    curl -fsSL "$UBUNTU_MIRROR/dists/$suite/$component/binary-arm64/Packages.xz" | xz -d >> "$TMP/Packages"
    printf '\n' >> "$TMP/Packages"
  done
done

mkdir -p "$UBUNTU_ROOT"
for package in "${UBUNTU_PACKAGES[@]}"; do
  file="$(awk -v want="$package" '
    /^Package: / { name = $2 }
    /^Filename: / && name == want { print $2; exit }
  ' "$TMP/Packages")"
  if [ -z "$file" ]; then
    echo "ubuntu has no $package" >&2
    exit 1
  fi
  echo "fetching $package from ubuntu"
  curl -fsSL "$UBUNTU_MIRROR/$file" -o "$TMP/package.deb"
  dpkg-deb -x "$TMP/package.deb" "$UBUNTU_ROOT"
done

# A plain RPATH, unlike RUNPATH, is also searched for the libraries those libraries need.
LIBS="\$ORIGIN:$UBUNTU_ROOT/usr/lib/aarch64-linux-gnu:$GLIBC/lib"
for binary in pixel chrome_crashpad_handler; do
  "$GLIBC/bin/patchelf" --set-interpreter "$GLIBC/lib/ld-linux-aarch64.so.1" "$APP/electron/$binary"
  "$GLIBC/bin/patchelf" --remove-rpath "$APP/electron/$binary"
  "$GLIBC/bin/patchelf" --force-rpath --set-rpath "$LIBS" "$APP/electron/$binary"
done

# Ubuntu's libpulse looks for its private libpulsecommon under /usr, which is not where we unpacked it.
LIBPULSE="$UBUNTU_ROOT/usr/lib/aarch64-linux-gnu/libpulse.so.0"
"$GLIBC/bin/patchelf" --remove-rpath "$LIBPULSE"
"$GLIBC/bin/patchelf" --force-rpath --set-rpath "\$ORIGIN/pulseaudio:\$ORIGIN:$GLIBC/lib" "$LIBPULSE"

missing="$(for binary in "$APP/electron/pixel" "$LIBPULSE"; do
  env -u LD_PRELOAD "$GLIBC/lib/ld-linux-aarch64.so.1" --list "$binary" 2>&1
done | awk '/not found|error while loading/' || true)"
if [ -n "$missing" ]; then
  echo "electron still misses libraries:" >&2
  echo "$missing" >&2
  exit 1
fi
echo "terminal-browser is ready to run on Termux"
