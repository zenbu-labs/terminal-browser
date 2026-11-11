import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const release = process.argv.includes("--release");
const packageDir = path.resolve(import.meta.dirname, "..");
const engineDir = path.resolve(packageDir, "..", "..", "engine");
const platform = `${process.platform}-${process.arch}`;
const outDir = path.join(packageDir, "..", "native", platform);

execFileSync("cargo", ["build", "-p", "pixel-node", ...(release ? ["--release"] : [])], {
  cwd: engineDir,
  stdio: "inherit",
});

const targetDir = process.env.CARGO_TARGET_DIR ?? path.join(engineDir, "target");
const library = process.platform === "darwin" ? "libpixel_node.dylib" : "libpixel_node.so";
const built = path.join(targetDir, release ? "release" : "debug", library);

fs.mkdirSync(outDir, { recursive: true });
fs.rmSync(path.join(outDir, "pixel.node"), { force: true });
fs.copyFileSync(built, path.join(outDir, "pixel.node"));

if (process.platform === "darwin") {
  // Apple's strip pads the LINKEDIT string table correctly; rust-objcopy
  // (what rustc would use) does not, and macOS 27.2's dyld rejects the result.
  if (release) execFileSync("/usr/bin/strip", ["-x", path.join(outDir, "pixel.node")], { stdio: "inherit" });
  const arch = process.arch === "arm64" ? "arm64" : "x86_64";
  execFileSync(
    "swiftc",
    [
      "-O",
      "-target",
      `${arch}-apple-macos11`,
      path.join(engineDir, "crates", "pixel-kitty", "native-scroll-helper.swift"),
      "-o",
      path.join(outDir, "native-scroll-helper"),
    ],
    { stdio: "inherit" },
  );
}

process.stdout.write(`built native artifacts into ${path.relative(process.cwd(), outDir)}\n`);
