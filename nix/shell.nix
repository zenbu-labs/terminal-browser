{ pkgs }:

pkgs.mkShell {
  packages = with pkgs; [
    nodejs_22
    pnpm_10
    cargo
    rustc
    pkg-config
    python3
    unzip
    git
  ];

  shellHook = ''
    export LD_LIBRARY_PATH=${
      pkgs.lib.makeLibraryPath (
        with pkgs;
        [
          alsa-lib
          at-spi2-atk
          at-spi2-core
          atk
          cairo
          cups
          dbus
          expat
          fontconfig
          freetype
          gdk-pixbuf
          glib
          gtk3
          libdrm
          libgbm
          libglvnd
          libnotify
          libpulseaudio
          libuuid
          libX11
          libXcomposite
          libXdamage
          libXext
          libXfixes
          libXrandr
          libxcb
          libxkbcommon
          mesa
          nspr
          nss
          pango
          stdenv.cc.cc
        ]
      )
    }:$LD_LIBRARY_PATH
  '';
}
