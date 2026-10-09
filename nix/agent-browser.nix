{
  lib,
  rustPlatform,
  fetchFromGitHub,
}:

rustPlatform.buildRustPackage (finalAttrs: {
  pname = "agent-browser";
  version = "0.33.0";

  src = fetchFromGitHub {
    owner = "vercel-labs";
    repo = "agent-browser";
    tag = "v${finalAttrs.version}";
    hash = "sha256-praWvAgWoDmWqXzh/kxdfQAPGkVS4qkb0pPYtMWO/N8=";
  };

  cargoHash = "sha256-j2tkoO334dtl22ykqBz5A0RTLrefyREAiXFKqTXEsgM=";

  sourceRoot = "${finalAttrs.src.name}/cli";

  postUnpack = ''
    chmod -R u+w "$(dirname "$sourceRoot")"
  '';

  postPatch = ''
    mkdir -p ../packages/dashboard/out
    echo '<!DOCTYPE html><html><body><p>Dashboard not built. Run: cd packages/dashboard && pnpm build</p></body></html>' > ../packages/dashboard/out/index.html
  '';

  preCheck = ''
    export HOME="$NIX_BUILD_TOP/home"
    mkdir -p "$HOME"
  '';

  checkFlags = [
    "--skip=doctor::helpers::tests::test_which_exists_matches_common_binaries"
  ];

  meta = {
    description = "Agent-browser compatible CLI vendored by terminal-browser";
    homepage = "https://github.com/vercel-labs/agent-browser";
    license = lib.licenses.asl20;
    platforms = lib.platforms.unix;
    mainProgram = "agent-browser";
  };
})
