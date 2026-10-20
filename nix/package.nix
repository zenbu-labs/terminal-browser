{
  lib,
  stdenv,
  fetchurl,
  autoPatchelfHook,
  makeWrapper,
  alsa-lib,
  at-spi2-atk,
  cairo,
  cups,
  dbus,
  expat,
  gdk-pixbuf,
  glib,
  gtk3,
  libdrm,
  libgbm,
  libGL,
  libnotify,
  libpulseaudio,
  libsecret,
  libx11,
  libxcb,
  libxcomposite,
  libxdamage,
  libxext,
  libxfixes,
  libxkbcommon,
  libxkbfile,
  libxrandr,
  libxshmfence,
  nspr,
  nss,
  pango,
  pciutils,
  pipewire,
  speechd-minimal,
  systemd,
  vulkan-loader,
}:

let
  version = "0.5.8";
  releases = {
    x86_64-linux = {
      target = "linux-x64";
      hash = "sha256-wzC+M0Hvb2yxBuT7MsHWB1Sgjhp2QRQ6empNnpRI9hc=";
    };
    aarch64-linux = {
      target = "linux-arm64";
      hash = "sha256-n/5/wfKjCe0L5IwvNfulNPOBY9ZMIsDH3FOZSdTxnnE=";
    };
  };
  release = releases.${stdenv.hostPlatform.system};
  runtimeLibraries = [
    alsa-lib
    at-spi2-atk
    cairo
    cups
    dbus
    expat
    gdk-pixbuf
    glib
    gtk3
    libdrm
    libgbm
    libGL
    libnotify
    libpulseaudio
    libsecret
    libx11
    libxcb
    libxcomposite
    libxdamage
    libxext
    libxfixes
    libxkbcommon
    libxkbfile
    libxrandr
    libxshmfence
    nspr
    nss
    pango
    pciutils
    pipewire
    speechd-minimal
    stdenv.cc.cc
    systemd
    vulkan-loader
  ];
in
stdenv.mkDerivation {
  pname = "terminal-browser";
  inherit version;

  src = fetchurl {
    url = "https://terminal-browser.sh/install/dl/stable/v${version}/terminal-browser-${release.target}.tar.gz";
    inherit (release) hash;
  };

  sourceRoot = "terminal-browser";
  nativeBuildInputs = [ autoPatchelfHook makeWrapper ];
  buildInputs = runtimeLibraries;

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/lib/terminal-browser" "$out/bin"
    cp -R . "$out/lib/terminal-browser"
    makeWrapper "$out/lib/terminal-browser/bin/terminal-browser" "$out/bin/terminal-browser"

    runHook postInstall
  '';

  meta = {
    description = "Real browser that runs inside your terminal";
    homepage = "https://terminal-browser.sh";
    license = lib.licenses.mit;
    mainProgram = "terminal-browser";
    platforms = builtins.attrNames releases;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}
