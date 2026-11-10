import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ZED_REPO = "https://github.com/purduehackers/zed.git";
export const ZED_COMMIT = "49896e3e570aa4b9a7783fccb2c5cfc8a7e4db1d";
export const BUNDLE_BUILD = "49896e3e5-34493929292.1";
export const BUNDLE_SOURCE = `https://code.purduehackers.com/editor/${BUNDLE_BUILD}`;
export const BUNDLE_FILES = ["zed_web.js", "zed_web_bg.wasm", "zed-assets.tar"];

export const EXAMPLE_DIR = path.resolve(__dirname, "..");
export const WEB_DIR = path.join(EXAMPLE_DIR, "web");
export const CACHE_DIR = path.join(EXAMPLE_DIR, ".cache");
export const STATE_DIR = path.join(
  process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"),
  "pixel-zed",
);
export const SOCKET = path.join(STATE_DIR, "daemon.sock");
export const BUNDLE_DIR = path.join(CACHE_DIR, "bundle", BUNDLE_BUILD);
export const ZED_SOURCE_RECORD = path.join(CACHE_DIR, "zed-source");
export const ZED_SOURCE = process.env.ZED_SOURCE
  ? path.resolve(process.env.ZED_SOURCE)
  : fs.existsSync(ZED_SOURCE_RECORD)
    ? fs.readFileSync(ZED_SOURCE_RECORD, "utf8").trim()
    : path.join(CACHE_DIR, "zed");
export const SERVER_BIN = path.join(ZED_SOURCE, "target", "debug", "remote_server");

export function isSetUp(): boolean {
  return fs.existsSync(SERVER_BIN) && BUNDLE_FILES.every((file) => fs.existsSync(path.join(BUNDLE_DIR, file)));
}
