import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engineRoot = path.resolve(packageRoot, "../..");
const library =
  process.platform === "darwin"
    ? "libpixel_node.dylib"
    : process.platform === "linux"
      ? "libpixel_node.so"
      : null;

if (!library) {
  throw new Error(`unsupported platform: ${process.platform}`);
}

const result = spawnSync("cargo", ["build", "-p", "pixel-node"], {
  cwd: engineRoot,
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const targetDir = process.env.CARGO_TARGET_DIR ?? path.join(engineRoot, "target");
const nativeDir = path.join(packageRoot, "native");
mkdirSync(nativeDir, { recursive: true });
copyFileSync(path.join(targetDir, "debug", library), path.join(nativeDir, "pixel.node"));
