{
  description = "A real browser that runs inside your terminal";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;

      pkgsFor = system: nixpkgs.legacyPackages.${system} or (import nixpkgs { inherit system; });

      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];

      forAllSystems = f: lib.genAttrs supportedSystems (system: f (pkgsFor system));
    in
    {
      overlays.default = final: _: {
        terminal-browser = final.callPackage ./nix/package.nix { };
        agent-browser = final.callPackage ./nix/agent-browser.nix { };
      };

      nixosModules = {
        terminal-browser = import ./nix/module.nix;
        default = self.nixosModules.terminal-browser;
      };

      packages = forAllSystems (pkgs: rec {
        terminal-browser = pkgs.callPackage ./nix/package.nix { };
        agent-browser = pkgs.callPackage ./nix/agent-browser.nix { };
        default = terminal-browser;
      });

      checks = lib.genAttrs supportedSystems (system: {
        terminal-browser = self.packages.${system}.terminal-browser;
        agent-browser = self.packages.${system}.agent-browser;
      });

      devShells = forAllSystems (pkgs: {
        default = import ./nix/shell.nix { inherit pkgs; };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt-rfc-style);
    };
}
