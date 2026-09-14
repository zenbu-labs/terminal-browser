{
  lib,
  stdenv,
  src,
  version,
  rustPlatform,
  fetchurl,
  fetchPnpmDeps,
  pnpm_10,
  pnpmConfigHook,
  nodejs,
  pkg-config,
  nasm,
  libxcb,
  libxkbcommon,
  wayland,
  makeWrapper,
  wrapGAppsHook3,
  glib,
  gtk3,
  gtk4,
  bash,
  coreutils,
  procps,
  openssh,
  gnutar,
  gzip,
  autoPatchelfHook,
  electron_43-bin,
}:
let
  platform =
    {
      x86_64-linux = {
        tag = "linux-x64";
        electronHash = "81480d46732312e4014011b6b9326678d12088ceb108123bd8117295675c41d1";
        agentHash = "b77d85eb8d0d305be4170f9477c59f0304b3609dc39bf0e8b8c740a1abd1e08a";
      };
      aarch64-linux = {
        tag = "linux-arm64";
        electronHash = "567f33e8d49dd367f7ab7b2a1294b0b1b5d293178aa91d58c00e3e0448305492";
        agentHash = "fa7b238d76ab45a429c089629417f4f15d68cac9c4369932e5d09d62dada9264";
      };
    }
    .${stdenv.hostPlatform.system};
  electronVersion = (lib.importJSON ../browser/package.json).devDependencies.electron;
  electron = electron_43-bin.overrideAttrs {
    version = electronVersion;
    src = fetchurl {
      url = "https://github.com/zenbu-labs/electron-releases/releases/download/v${electronVersion}/electron-v${electronVersion}-${platform.tag}.zip";
      sha256 = platform.electronHash;
    };
  };
  agentVersion = lib.removePrefix "v" (
    builtins.head (builtins.match ''.*REF="([^"]+)".*'' (builtins.readFile ../scripts/agent-browser.sh))
  );
  agent = stdenv.mkDerivation {
    pname = "terminal-browser-agent";
    version = agentVersion;
    src = fetchurl {
      url = "https://github.com/vercel-labs/agent-browser/releases/download/v${agentVersion}/agent-browser-${platform.tag}";
      sha256 = platform.agentHash;
    };
    dontUnpack = true;
    nativeBuildInputs = [ autoPatchelfHook ];
    buildInputs = [ stdenv.cc.cc.lib ];
    installPhase = ''
      install -Dm755 $src $out/bin/agent-browser
    '';
  };
  native = rustPlatform.buildRustPackage {
    pname = "terminal-browser-native";
    inherit version;
    src = ../engine;
    cargoLock.lockFile = ../engine/Cargo.lock;
    nativeBuildInputs = [
      pkg-config
      nasm
    ];
    buildInputs = [
      libxcb
      libxkbcommon
      wayland
    ];
    cargoBuildFlags = [
      "-p"
      "pixel-node"
    ];
    cargoTestFlags = [
      "-p"
      "pixel-core"
    ];
    installPhase = ''
      runHook preInstall
      install -Dm755 target/${stdenv.hostPlatform.rust.rustcTarget}/release/libpixel_node.so $out/lib/pixel.node
      runHook postInstall
    '';
  };
in
stdenv.mkDerivation (finalAttrs: {
  pname = "terminal-browser";
  inherit version src;
  nativeBuildInputs = [
    nodejs
    pnpm_10
    pnpmConfigHook
    makeWrapper
    wrapGAppsHook3
  ];
  buildInputs = [
    glib
    gtk3
    gtk4
  ];
  dontWrapGApps = true;
  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    pnpm = pnpm_10;
    fetcherVersion = 3;
    hash = "sha256-bjfpcwPwDgPaDWRoLtfraqCSCzgWFbJt1rm6FL51Yo0=";
  };
  buildPhase = ''
    runHook preBuild
    patchShebangs scripts
    scripts/bundle.sh cli/src/main.ts cli/dist/main.js
    scripts/bundle.sh browser/src/main.tsx browser/dist/main.js
    pnpm --filter pixel-store build
    node --test store/test/paths.test.js
    scripts/copy-react-grab.sh
    scripts/generate-skill.sh
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    root=$out/lib/terminal-browser
    mkdir -p $root/{bin,cli,browser/native,assets,scripts}
    cp LICENSE $root/
    cp -r cli/dist $root/cli/
    cp -r browser/dist $root/browser/
    cp -r assets/fonts assets/react-grab $root/assets/
    cp -r skill/build $root/skills
    cp scripts/apparmor.sh $root/scripts/
    ln -s ${native}/lib/pixel.node $root/browser/native/pixel.node
    ln -s ${electron.dist} $root/electron
    ln -s ${agent} $root/agent-browser
    echo '${version}' > $root/VERSION
    runHook postInstall
  '';
  preFixup = ''
    root=$out/lib/terminal-browser
    makeShellWrapper ${lib.getExe nodejs} $out/bin/terminal-browser \
      "''${gappsWrapperArgs[@]}" \
      --prefix PATH : ${
        lib.makeBinPath [
          bash
          coreutils
          procps
          openssh
          gnutar
          gzip
        ]
      } \
      --set TERMINAL_BROWSER_DIST_ROOT $root \
      --add-flags $root/cli/dist/main.js \
      --run 'if [ "''${1-}" = upgrade ]; then echo "This installation is managed by Nix. Update your flake input or run nix profile upgrade."; exit 0; fi'
    ln -s $out/bin/terminal-browser $root/bin/terminal-browser
  '';
  meta = {
    description = "A browser inside your terminal";
    homepage = "https://github.com/zenbu-labs/terminal-browser";
    license = lib.licenses.mit;
    mainProgram = "terminal-browser";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
    ];
  };
})
