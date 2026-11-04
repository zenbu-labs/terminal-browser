#!/usr/bin/env node
// The Electron fuses every release ships with. release.sh writes them; the native probes and the conformance run
// test against a copy of their Electron with the same fuses, so tests see what a release's pages can do.
//   node scripts/fuses.mjs write <Electron.app | electron binary>   flips the fuses in place and prints them
//   node scripts/fuses.mjs fused <Electron.app | electron binary>   prints the binary of a copy with the fuses
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FuseState, FuseV1Options, FuseVersion, flipFuses, getCurrentFuseWire, pathToFuseFile } from "@electron/fuses";

export const RELEASE_FUSES = {
  [FuseV1Options.EnableCookieEncryption]: true,
  // file:// pages would otherwise read every local file; local files are shown through terminal-browser-file://
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  // --inspect and NODE_OPTIONS=--inspect would each open an unauthenticated debugger on a TCP port.
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
};

// The CLI runs as plain node through the same binary (ELECTRON_RUN_AS_NODE).
const REQUIRED_ENABLED = [FuseV1Options.RunAsNode];

const STATE_NAMES = { [FuseState.ENABLE]: "Enabled", [FuseState.DISABLE]: "Disabled", [FuseState.INHERIT]: "Inherit", [FuseState.REMOVED]: "Removed" };

async function describe(target) {
  const wire = await getCurrentFuseWire(target);
  return Object.entries(wire)
    .filter(([key]) => key !== "version")
    .map(([key, state]) => ({ name: FuseV1Options[key], key: Number(key), state }));
}

function mismatches(fuses) {
  const want = (key) => (key in RELEASE_FUSES ? (RELEASE_FUSES[key] ? FuseState.ENABLE : FuseState.DISABLE) : null);
  return fuses.filter(({ key, state }) => {
    if (REQUIRED_ENABLED.includes(key)) return state !== FuseState.ENABLE;
    const wanted = want(key);
    return wanted !== null && state !== wanted;
  });
}

export async function writeReleaseFuses(target) {
  await flipFuses(target, { version: FuseVersion.V1, ...RELEASE_FUSES });
  const fuses = await describe(target);
  const wrong = mismatches(fuses);
  if (wrong.length) throw new Error(`fuses.mjs: ${wrong.map((fuse) => `${fuse.name} is ${STATE_NAMES[fuse.state]}`).join(", ")} in ${target}`);
  return fuses.map((fuse) => `${fuse.name} is ${STATE_NAMES[fuse.state]}`).join("\n");
}

function appBundleOf(binary) {
  const match = /^(.*?\.app)(?:[\\/]Contents[\\/]MacOS[\\/].*)?$/.exec(binary);
  return match ? match[1] : null;
}

// A copy of the Electron at `electron` (an .app or a binary) with the release fuses, reused while the original is
// unchanged. Returns the copy's binary, or `electron` itself when it already has the release fuses.
export async function fusedElectron(electron) {
  const source = fs.realpathSync(electron);
  if (mismatches(await describe(source)).length === 0) return electron;
  const bundle = appBundleOf(source);
  const binary = bundle && source === bundle ? path.join(bundle, "Contents", "MacOS", fs.readdirSync(path.join(bundle, "Contents", "MacOS"))[0]) : source;
  const root = bundle ?? path.dirname(source);
  const stat = fs.statSync(pathToFuseFile(source));
  const key = crypto.createHash("sha256").update(JSON.stringify([root, stat.size, stat.mtimeMs, RELEASE_FUSES])).digest("hex").slice(0, 16);
  const cache = path.join(os.tmpdir(), "terminal-browser-fused-electron", key);
  const copy = path.join(cache, path.basename(root));
  const copiedBinary = path.join(copy, path.relative(root, binary));
  if (fs.existsSync(path.join(cache, "ready"))) return copiedBinary;
  fs.rmSync(cache, { recursive: true, force: true });
  fs.mkdirSync(cache, { recursive: true });
  if (process.platform === "darwin") execFileSync("ditto", [root, copy]);
  else fs.cpSync(root, copy, { recursive: true, verbatimSymlinks: true });
  await writeReleaseFuses(bundle ? copy : copiedBinary);
  if (process.platform === "darwin" && bundle) execFileSync("codesign", ["--force", "--deep", "--sign", "-", copy], { stdio: "ignore" });
  fs.writeFileSync(path.join(cache, "ready"), "");
  return copiedBinary;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, target] = process.argv.slice(2);
  if (command === "write" && target) console.log(await writeReleaseFuses(target));
  else if (command === "fused" && target) console.log(await fusedElectron(target));
  else {
    // fixme: placeholder copy
    console.error("usage: fuses.mjs write|fused <Electron.app or electron binary>");
    process.exit(2);
  }
}
