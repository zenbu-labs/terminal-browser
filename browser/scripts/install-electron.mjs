import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

// .npmrc points at the patched mac build, which has no linux release
const install = createRequire(import.meta.url).resolve("electron/install.js");
const env = { ...process.env };
if (process.platform === "linux") {
  env.npm_config_electron_mirror = "https://github.com/electron/electron/releases/download/";
}

const { error, status } = spawnSync(process.execPath, [install], {
  cwd: path.dirname(install),
  env,
  stdio: "inherit",
});

if (error) throw error;
if (status !== 0) process.exit(status ?? 1);
