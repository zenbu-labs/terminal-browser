#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  BUNDLE_DIR,
  BUNDLE_FILES,
  BUNDLE_SOURCE,
  SERVER_BIN,
  ZED_COMMIT,
  ZED_REPO,
  ZED_SOURCE,
  ZED_SOURCE_RECORD,
} from "./paths";

function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  console.log(`$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
}

function currentCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ZED_SOURCE, stdio: "pipe" }).toString().trim();
  } catch {
    return null;
  }
}

function checkoutZed() {
  if (process.env.ZED_SOURCE) {
    console.log(`using the zed checkout at ${ZED_SOURCE}`);
    return;
  }
  if (!fs.existsSync(path.join(ZED_SOURCE, ".git"))) {
    fs.mkdirSync(ZED_SOURCE, { recursive: true });
    run("git", ["init", "--quiet"], ZED_SOURCE);
    run("git", ["remote", "add", "origin", ZED_REPO], ZED_SOURCE);
  }
  if (currentCommit() === ZED_COMMIT) return;
  run("git", ["fetch", "--depth", "1", "origin", ZED_COMMIT], ZED_SOURCE);
  run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], ZED_SOURCE);
}

function buildServer() {
  run("cargo", ["build", "--locked", "-p", "remote_server", "--features", "serve"], ZED_SOURCE, {
    ZS_BUILD_ID: "dev-0",
  });
  if (!fs.existsSync(SERVER_BIN)) throw new Error(`cargo did not produce ${SERVER_BIN}`);
}

async function downloadBundle() {
  fs.mkdirSync(BUNDLE_DIR, { recursive: true });
  for (const file of BUNDLE_FILES) {
    const target = path.join(BUNDLE_DIR, file);
    if (fs.existsSync(target)) continue;
    console.log(`downloading ${BUNDLE_SOURCE}/${file}`);
    const response = await fetch(`${BUNDLE_SOURCE}/${file}`);
    if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
    const partial = `${target}.partial`;
    fs.writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
    fs.renameSync(partial, target);
  }
}

async function main() {
  checkoutZed();
  await downloadBundle();
  buildServer();
  fs.writeFileSync(ZED_SOURCE_RECORD, ZED_SOURCE);
  console.log("ready: pnpm zed [folder]");
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
