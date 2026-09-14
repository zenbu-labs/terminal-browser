{
  description = "A browser inside your terminal";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  outputs =
    { self, nixpkgs }:
    let
      eachSystem = nixpkgs.lib.genAttrs [
        "x86_64-linux"
        "aarch64-linux"
      ];
    in
    {
      packages = eachSystem (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          terminal-browser = pkgs.callPackage ./nix/package.nix {
            src = self;
            version = "unstable-${self.shortRev or self.dirtyShortRev or "unknown"}";
          };
        in
        {
          inherit terminal-browser;
          default = terminal-browser;
        }
      );
    };
}
