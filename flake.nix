{
  description = "A real browser that runs inside your terminal";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forEachSystem = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forEachSystem (pkgs:
        let
          terminal-browser = pkgs.callPackage ./nix/package.nix { };
        in
        {
          default = terminal-browser;
          inherit terminal-browser;
        });

      apps = forEachSystem (pkgs: {
        default = {
          type = "app";
          program = "${pkgs.callPackage ./nix/package.nix { }}/bin/terminal-browser";
          meta.description = "Run terminal-browser";
        };
      });
    };
}
