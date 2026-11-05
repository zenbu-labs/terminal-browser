{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.terminal-browser;

  inherit (lib.options) mkEnableOption mkOption;
  inherit (lib.modules) mkIf;
  inherit (lib.types) package;
in
{
  options.programs.terminal-browser = {
    enable = mkEnableOption "terminal-browser, a real browser inside your terminal";

    package = mkOption {
      type = package;
      default = pkgs.callPackage ./package.nix { };
      description = "The terminal-browser package to install.";
    };
  };

  config = mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];
  };
}
