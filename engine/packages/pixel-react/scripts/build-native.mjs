import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const packageDir = path.resolve(import.meta.dirname, "..");
execFileSync("cargo", ["build", "-p", "pixel-node"], { cwd: packageDir, stdio: "inherit" });

const targetDir = path.resolve(packageDir, process.env.CARGO_TARGET_DIR ?? "../../target");
const library = process.platform === "darwin" ? "libpixel_node.dylib" : "libpixel_node.so";
const source = path.join(targetDir, "debug", library);
const destination = path.join(packageDir, "native", "pixel.node");

fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.rmSync(destination, { force: true });
fs.copyFileSync(source, destination);
