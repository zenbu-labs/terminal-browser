import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const install = require.resolve("electron/install.js");
const mirror =
  process.platform === "darwin"
    ? "https://github.com/zenbu-labs/electron-releases/releases/download/"
    : process.platform === "linux"
      ? "https://github.com/electron/electron/releases/download/"
      : null;

if (!mirror) {
  throw new Error(`unsupported platform: ${process.platform}`);
}

const result = spawnSync(process.execPath, [install], {
  cwd: path.dirname(install),
  env: {
    ...process.env,
    ELECTRON_MIRROR: mirror,
    npm_config_electron_mirror: mirror,
    ELECTRON_CUSTOM_DIR: "v{{ version }}",
    npm_config_electron_custom_dir: "v{{ version }}",
    electron_use_remote_checksums: "1",
  },
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
