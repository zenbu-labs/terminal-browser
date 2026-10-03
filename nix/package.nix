{
  lib,
  stdenv,
  callPackage,
  fetchurl,
  fetchPnpmDeps,
  pnpm_10,
  pnpmConfigHook,
  pnpmBuildHook,
  nodejs_22,
  python3,
  makeWrapper,
  wrapGAppsHook3,
  addDriverRunpath,
  autoPatchelfHook,
  unzip,
  alsa-lib,
  at-spi2-atk,
  at-spi2-core,
  atk,
  cairo,
  cups,
  dbus,
  expat,
  fontconfig,
  freetype,
  gdk-pixbuf,
  glib,
  gtk3,
  libdrm,
  libgbm,
  libglvnd,
  libnotify,
  libpulseaudio,
  libuuid,
  libX11,
  libXcomposite,
  libXdamage,
  libXext,
  libXfixes,
  libXrandr,
  libxcb,
  libxkbcommon,
  mesa,
  nspr,
  nss,
  pango,
  agentBrowser ? callPackage ./agent-browser.nix { },
}:

let
  pname = "terminal-browser";
  version = (lib.importJSON ../browser/package.json).version;

  electronVersion = "44.2.0";

  electronTarget =
    {
      x86_64-linux = "linux-x64";
      aarch64-linux = "linux-arm64";
      aarch64-darwin = "darwin-arm64";
      x86_64-darwin = "darwin-x64";
    }
    .${stdenv.hostPlatform.system}
      or (throw "terminal-browser: unsupported system ${stdenv.hostPlatform.system}");

  electronHashes = {
    linux-x64 = {
      zip = "sha256-Scc8koBNopPHX/fkFGmnUT0CF6TTczIFSXcHXrQmFdk=";
      marker = "49c73c92804da293c75ff7e41469a7513d0217a4d37332054977075eb42615d9";
    };
    linux-arm64 = {
      zip = "sha256-wnb1Toia7p7xSmKPnr4vp0pzTBzrN2NyIErDQG+l418=";
      marker = "c276f54e889aee9ef14a628f9ebe2fa74a734c1ceb376372204ac3406fa5e35f";
    };
    darwin-arm64 = {
      zip = "sha256-U7B3Hj5JUTtvEH2zIKjEvWcCXuKFdge4NSeqrjQoTsA=";
      marker = "53b0771e3e49513b6f107db320a8c4bd67025ee2857607b83527aaae34284ec0";
    };
    darwin-x64 = {
      zip = "sha256-hdizziBQX28F/Mrw6ihv5UqDbfL2XKgsmMbV0FaeF5Q=";
      marker = "85d8b3ce20505f6f05fccaf0ea286fe54a836df2f65ca82c98c6d5d0569e1794";
    };
  };

  electronZip = fetchurl {
    url = "https://github.com/zenbu-labs/pixel/releases/download/electron-v${electronVersion}/electron-v${electronVersion}-${electronTarget}.zip";
    hash = electronHashes.${electronTarget}.zip;
  };

  electronFuses = fetchurl {
    url = "https://registry.npmjs.org/@electron/fuses/-/fuses-2.1.3.tgz";
    hash = "sha512-LoKJUXNiJ4JM8IIrUltSHI+8pkogaGj5wmJx81jE/Wk3g2w1/kfMbTEKNoY5kitGE8hiC12h32R/1SlywFtxXg==";
  };

  electronTypesSha = "2fe88318975e18ef0da4b95a827a3232f55b02974422dedc812e29442f128d25";
  electronTypes = fetchurl {
    url = "https://github.com/zenbu-labs/pixel/releases/download/electron-v${electronVersion}/electron.d.ts";
    hash = "sha256-L+iDGJdeGO8NpLlagnoyMvVbApdEIt7cgS4pRC8SjSU=";
  };

  electronExe =
    if stdenv.hostPlatform.isDarwin then
      "electron/terminal-browser.app/Contents/MacOS/terminal-browser"
    else
      "electron/pixel";

  src = lib.cleanSource ../.;
in
stdenv.mkDerivation (finalAttrs: {
  inherit pname version src;

  pnpmDeps = fetchPnpmDeps {
    inherit pname version src;
    pnpm = pnpm_10;
    fetcherVersion = 4;
    hash = "sha256-TfOXh8CuMe+ih6D75rJiU3QCaWYnoMhNOFM9dP5T1S4=";
  };

  nativeBuildInputs = [
    nodejs_22
    pnpm_10
    pnpmConfigHook
    pnpmBuildHook
    makeWrapper
    unzip
  ]
  ++ lib.optionals stdenv.hostPlatform.isLinux [
    autoPatchelfHook
    wrapGAppsHook3
    addDriverRunpath
  ]
  ++ lib.optionals stdenv.hostPlatform.isDarwin [ python3 ];

  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [
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
  ];

  dontWrapGApps = true;
  dontStrip = true;

  preConfigure = ''
    export HOME="$NIX_BUILD_TOP/home"
    mkdir -p "$HOME"
  '';

  preBuild = ''
    patchShebangs scripts
    bash scripts/copy-react-grab.sh

    pixelDir="$(node -e 'process.stdout.write(require("path").dirname(require.resolve("@zenbu-labs/pixel/package.json", { paths: [process.argv[1]] })))' "$PWD/browser")"
    pixelDir="$(realpath "$pixelDir")"
    mkdir -p "$pixelDir/electron"
    cp "${electronTypes}" "$pixelDir/electron/electron.d.ts"
    printf '%s' '${electronVersion} ${electronTypesSha}' > "$pixelDir/electron/.electron.d.ts.source"
    rm -rf "$pixelDir/electron/dist"
    mkdir -p "$pixelDir/electron/dist"
    unzip -q "${electronZip}" -d "$pixelDir/electron/dist"
    printf '%s' '${
      electronHashes.${electronTarget}.marker
    }' > "$pixelDir/electron/dist/.zenbu-electron-sha256"
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p "$out"/{bin,cli/dist,browser/dist,browser/node_modules/@zenbu-labs,electron,agent-browser/bin,assets/fonts,scripts}

    nativePkg="$(node -e '
      const path = require("path"), fs = require("fs");
      const lib = require.resolve("@zenbu-labs/pixel/package.json", { paths: [process.argv[1]] });
      const pkg = require.resolve(`@zenbu-labs/pixel-native-''${process.argv[2]}/package.json`, { paths: [path.dirname(lib)] });
      process.stdout.write(fs.realpathSync(path.dirname(pkg)));
    ' "$PWD/browser" "${electronTarget}")"
    cp -RL "$nativePkg" "$out/browser/node_modules/@zenbu-labs/pixel-native-${electronTarget}"

    cp "${agentBrowser}/bin/agent-browser" "$out/agent-browser/bin/agent-browser"

    bash scripts/bundle.sh "$PWD/cli/src/main.ts" "$out/cli/dist/main.js"
    bash scripts/bundle.sh "$PWD/browser/src/main.tsx" "$out/browser/dist/main.js"

    cp scripts/apparmor.sh "$out/scripts/apparmor.sh"

    bash scripts/generate-skill.sh
    cp -R skill/build "$out/skills"

    cp assets/fonts/JetBrainsMono-Regular.ttf "$out/assets/fonts/"
    mkdir -p "$out/assets/react-grab"
    cp assets/react-grab/* "$out/assets/react-grab/"
    mkdir -p "$out/assets/search"
    cp assets/search/* "$out/assets/search/"

    pixelDist="$(node -e '
      const path = require("path");
      const lib = require.resolve("@zenbu-labs/pixel/package.json", { paths: [process.argv[1]] });
      process.stdout.write(path.join(path.dirname(lib), "electron", "dist"));
    ' "$PWD/browser")"
    ${lib.optionalString stdenv.hostPlatform.isLinux ''
      cp -a "$pixelDist/." "$out/electron/"

      fusesDir="$(mktemp -d)"
      tar -xzf "${electronFuses}" -C "$fusesDir"
      NO_COLOR=1 node "$fusesDir/package/dist/bin.js" write --app "$out/electron/pixel" EnableCookieEncryption=on
      NO_COLOR=1 node "$fusesDir/package/dist/bin.js" read --app "$out/electron/pixel" | sed 's/\x1b\[[0-9;]*m//g' | tee fuses.txt
      grep -q "EnableCookieEncryption is Enabled" fuses.txt
      grep -q "RunAsNode is Enabled" fuses.txt
      rm -rf "$fusesDir"
    ''}
    ${lib.optionalString stdenv.hostPlatform.isDarwin ''
      cp -a "$pixelDist/Electron.app" "$out/electron/terminal-browser.app"
      mv "$out/electron/terminal-browser.app/Contents/MacOS/pixel" "$out/electron/terminal-browser.app/Contents/MacOS/terminal-browser"
      python3 - "$out/electron/terminal-browser.app/Contents/Info.plist" <<'PYEOF'
      import plistlib, sys
      with open(sys.argv[1], "rb") as f:
          info = plistlib.load(f)
      info.update({
          "CFBundleExecutable": "terminal-browser",
          "CFBundleName": "terminal-browser",
          "CFBundleDisplayName": "terminal-browser",
          "CFBundleIdentifier": "dev.zenbu.terminal-browser",
      })
      with open(sys.argv[1], "wb") as f:
          plistlib.dump(info, f)
      PYEOF
      rm -f "$out/browser/node_modules/@zenbu-labs/pixel-native-${electronTarget}/native-scroll-helper"
      cp "$nativePkg/native-scroll-helper" "$out/bin/native-scroll-helper"
      for binary in "$out"/bin/native-scroll-helper "$out"/agent-browser/bin/agent-browser "$out"/browser/node_modules/@zenbu-labs/pixel-native-*/pixel.node "$out"/electron/terminal-browser.app; do
        codesign --force --sign - --timestamp=none "$binary" 2>/dev/null || echo "warning: codesign unavailable for $binary" >&2
      done
    ''}

    cat > "$out/bin/terminal-browser" <<'LAUNCHER_EOF'
    #!/bin/sh
    SELF="$0"
    while [ -L "$SELF" ]; do
      LINK="$(readlink "$SELF")"
      case "$LINK" in
        /*) SELF="$LINK" ;;
        *) SELF="$(dirname -- "$SELF")/$LINK" ;;
      esac
    done
    ROOT="$(CDPATH= cd -- "$(dirname -- "$SELF")/.." && pwd -P)"
    export TERMINAL_BROWSER_DIST_ROOT="$ROOT"
    export ELECTRON_RUN_AS_NODE=1
    LAUNCHER_EOF
    ${lib.optionalString stdenv.hostPlatform.isDarwin ''
      echo 'export NATIVE_SCROLL_HELPER="''${NATIVE_SCROLL_HELPER:-$ROOT/bin/native-scroll-helper}"' >> "$out/bin/terminal-browser"
    ''}
    echo 'exec "$ROOT/${electronExe}" "$ROOT/cli/dist/main.js" "$@"' >> "$out/bin/terminal-browser"
    chmod +x "$out/bin/terminal-browser"

    echo "${version}" > "$out/VERSION"
    echo "nix" > "$out/CHANNEL"

    runHook postInstall
  '';

  postFixup = lib.optionalString stdenv.hostPlatform.isLinux ''
    wrapProgram "$out/bin/terminal-browser" \
      "''${gappsWrapperArgs[@]}" \
      --prefix LD_LIBRARY_PATH : "$out/electron:${addDriverRunpath.driverLink}/lib" \
      --suffix VK_ADD_DRIVER_FILES : "${addDriverRunpath.driverLink}/share/vulkan/icd.d"
  '';

  passthru = {
    inherit agentBrowser;
  };

  meta = {
    description = "A real browser that runs inside your terminal";
    homepage = "https://github.com/zenbu-labs/terminal-browser";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
    mainProgram = "terminal-browser";
  };
})
