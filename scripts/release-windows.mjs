import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// The Windows counterpart of release.sh: stages dist-release/terminal-browser and zips it.
const ROOT = path.resolve(import.meta.dirname, "..");
const VERSION = process.argv[2] ?? "dev";
const CHANNEL = process.argv[3] ?? "dev";
const TARGET = "win32-x64";
const OUT = path.join(ROOT, "dist-release");
const STAGE = path.join(OUT, "terminal-browser");
const AGENT_BROWSER_REF = "v0.38.1";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error(`release-windows builds on win32-x64, not ${process.platform}-${process.arch}`);
}

const run = (command, args, options = {}) => execFileSync(command, args, { stdio: "inherit", cwd: ROOT, ...options });
const step = (name) => process.stderr.write(`\nrelease: ${name}\n`);
const copyTree = (from, to) => fs.cpSync(from, to, { recursive: true, dereference: true });

fs.rmSync(OUT, { recursive: true, force: true });
for (const dir of ["bin", "cli/dist", "browser/dist", "node_modules/@zenbu-labs", "electron", "agent-browser/bin", "assets/fonts", "plugins"]) {
  fs.mkdirSync(path.join(STAGE, dir), { recursive: true });
}

step("native engine (release build)");
run(process.execPath, [path.join(ROOT, "pixel/packages/pixel/scripts/build-native.mjs"), "--release"]);
const nativePackage = fs.realpathSync(path.join(ROOT, "pixel/packages/native", TARGET));
if (!fs.existsSync(path.join(nativePackage, "pixel.node"))) throw new Error(`${nativePackage} has no pixel.node`);
// Both the cli, for its console relay, and the browser load the engine, so it sits above both.
copyTree(nativePackage, path.join(STAGE, "node_modules/@zenbu-labs", `pixel-native-${TARGET}`));

step("bundles");
const esbuild = createRequire(path.join(ROOT, "package.json"))("esbuild");
for (const [entry, outfile] of [
  ["cli/src/main.ts", "cli/dist/main.js"],
  ["browser/src/main.tsx", "browser/dist/main.js"],
]) {
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron", "*.node"],
    alias: { shared: path.join(ROOT, "shared/src/index.ts") },
    define: { "process.env.NODE_ENV": '"production"' },
    sourcemap: true,
    outfile: path.join(STAGE, outfile),
    logLevel: "warning",
  });
  fs.writeFileSync(path.join(STAGE, path.dirname(outfile), "package.json"), '{"type":"commonjs"}\n');
}

step("skills and react-grab (Git Bash)");
run("bash", ["scripts/generate-skill.sh"]);
copyTree(path.join(ROOT, "skill/build"), path.join(STAGE, "skills"));
run("bash", ["scripts/copy-react-grab.sh"]);

step("assets");
fs.copyFileSync(path.join(ROOT, "assets/fonts/JetBrainsMono-Regular.ttf"), path.join(STAGE, "assets/fonts/JetBrainsMono-Regular.ttf"));
for (const dir of ["react-grab", "search", "chromium"]) copyTree(path.join(ROOT, "assets", dir), path.join(STAGE, "assets", dir));

step("agent-browser");
const agentCache = path.join(process.env.LOCALAPPDATA, "terminal-browser", "agent-browser", AGENT_BROWSER_REF);
const agentBinary = path.join(agentCache, "bin", "agent-browser.exe");
if (!fs.existsSync(agentBinary)) {
  run("cargo", ["install", "--git", "https://github.com/vercel-labs/agent-browser", "--tag", AGENT_BROWSER_REF, "--locked", "--root", agentCache, "agent-browser"]);
}
fs.copyFileSync(agentBinary, path.join(STAGE, "agent-browser/bin/agent-browser.exe"));

step("electron");
const pixelDir = path.dirname(createRequire(path.join(ROOT, "browser/package.json")).resolve("@zenbu-labs/pixel/package.json"));
const electronDist = path.join(pixelDir, "electron", "dist");
if (!fs.existsSync(path.join(electronDist, ".zenbu-electron-sha256"))) throw new Error("pixel has not installed electron (run pnpm install)");
copyTree(electronDist, path.join(STAGE, "electron"));
const tools = path.join(OUT, "tools");
fs.mkdirSync(tools, { recursive: true });
fs.writeFileSync(path.join(tools, "package.json"), '{"private":true}\n');
run("npm", ["install", "--no-audit", "--no-fund", "--silent", "@electron/fuses@2.1.3"], { cwd: tools, shell: true });
const fuses = path.join(tools, "node_modules/@electron/fuses/dist/bin.js");
const electronExe = path.join(STAGE, "electron", "electron.exe");
run(process.execPath, [fuses, "write", "--app", electronExe, "EnableCookieEncryption=on"], { env: { ...process.env, NO_COLOR: "1" } });
const fuseReport = execFileSync(process.execPath, [fuses, "read", "--app", electronExe], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } })
  .replace(/\x1b\[[0-9;]*m/g, "");
fs.writeFileSync(path.join(OUT, "fuses.txt"), fuseReport);
// The launcher runs the cli inside this electron as node, so that fuse has to stay on.
for (const needed of ["EnableCookieEncryption is Enabled", "RunAsNode is Enabled"]) {
  if (!fuseReport.includes(needed)) throw new Error(`electron fuses: expected "${needed}"\n${fuseReport}`);
}

step("launcher");
const stdcpp = execFileSync("gcc", ["-print-file-name=libstdc++.a"], { encoding: "utf8" }).trim();
run("cargo", ["build", "--release"], {
  cwd: path.join(ROOT, "windows/launcher"),
  env: { ...process.env, RUSTFLAGS: `-C link-arg=-static -L native=${path.dirname(stdcpp)}` },
});
fs.copyFileSync(path.join(ROOT, "windows/launcher/target/release/terminal-browser.exe"), path.join(STAGE, "bin/terminal-browser.exe"));

step("claude code plugin");
// Kept away from cli/ so the plugin does not mistake the release for a checkout and runs the launcher.
const plugin = path.join(STAGE, "plugins", "claude-code");
for (const part of [".claude-plugin", "hooks", "README.md"]) copyTree(path.join(ROOT, "claude-code-plugin", part), path.join(plugin, part));
fs.rmSync(path.join(plugin, ".claude-plugin", "types"), { recursive: true, force: true });
for (const test of fs.readdirSync(path.join(plugin, "hooks")).filter((file) => file.endsWith(".test.ts"))) {
  fs.rmSync(path.join(plugin, "hooks", test));
}

fs.writeFileSync(path.join(STAGE, "VERSION"), `${VERSION}\n`);
fs.writeFileSync(path.join(STAGE, "CHANNEL"), `${CHANNEL}\n`);

step("zip");
const zip = path.join(OUT, `terminal-browser-${TARGET}.zip`);
const windowsTar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
run(windowsTar, ["-a", "-c", "-f", zip, "-C", OUT, "terminal-browser"]);
const bytes = fs.readFileSync(zip);
const manifest = {
  version: VERSION,
  channel: CHANNEL,
  platform: TARGET,
  file: path.basename(zip),
  sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  size: bytes.length,
  published: new Date().toISOString(),
};
fs.writeFileSync(path.join(OUT, `manifest-${TARGET}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
process.stderr.write(`\nrelease: ${zip} (${(bytes.length / 1e6).toFixed(0)} MB, sha256 ${manifest.sha256})\n`);
