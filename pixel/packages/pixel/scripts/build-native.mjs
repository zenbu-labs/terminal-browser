import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const release = process.argv.includes("--release");
const packageDir = path.resolve(import.meta.dirname, "..");
const engineDir = path.resolve(packageDir, "..", "..", "engine");
const platform = `${process.platform}-${process.arch}`;
const outDir = path.join(packageDir, "..", "native", platform);

const targetDir = process.env.CARGO_TARGET_DIR ?? path.join(engineDir, "target");

execFileSync("cargo", ["build", "-p", "pixel-node", ...(release ? ["--release"] : [])], {
  cwd: engineDir,
  stdio: "inherit",
  env: process.platform === "win32" ? windowsBuildEnv() : process.env,
});

// Stock node and electron ship no MinGW runtime, so the C++ and gcc runtimes are linked in.
function windowsBuildEnv() {
  const stdcpp = execFileSync("gcc", ["-print-file-name=libstdc++.a"], { encoding: "utf8" }).trim();
  return {
    ...process.env,
    LIBNODE_PATH: emptyLibnode(),
    CXXSTDLIB: "static=stdc++",
    RUSTFLAGS: `-C link-arg=-static -L native=${path.dirname(stdcpp)}`,
  };
}

// The addon looks up every node function in the host process at runtime, but the napi build
// script still insists on linking a libnode.dll, so it gets an empty archive under that name.
function emptyLibnode() {
  const dir = path.join(targetDir, "napi-gnu");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "libnode.dll"), "!<arch>\n");
  return dir;
}

const library = {
  darwin: "libpixel_node.dylib",
  win32: "pixel_node.dll",
}[process.platform] ?? "libpixel_node.so";
const built = path.join(targetDir, release ? "release" : "debug", library);

fs.mkdirSync(outDir, { recursive: true });
fs.rmSync(path.join(outDir, "pixel.node"), { force: true });
fs.copyFileSync(built, path.join(outDir, "pixel.node"));

if (process.platform === "darwin") {
  const arch = process.arch === "arm64" ? "arm64" : "x86_64";
  execFileSync(
    "swiftc",
    [
      "-O",
      "-target",
      `${arch}-apple-macos11`,
      path.join(engineDir, "crates", "pixel-core", "native-scroll-helper.swift"),
      "-o",
      path.join(outDir, "native-scroll-helper"),
    ],
    { stdio: "inherit" },
  );
}

process.stdout.write(`built native artifacts into ${path.relative(process.cwd(), outDir)}\n`);
