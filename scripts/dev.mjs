#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "cli", "dist", "main.js");
const SOCKET = path.join(os.tmpdir(), `terminal-browser-dev-${process.pid}.sock`);
const DEFAULT_URL = "https://terminal-browser.com";
const browserArgs = process.argv.slice(2);
if (!browserArgs.some((arg) => !arg.startsWith("-"))) browserArgs.push(DEFAULT_URL);

let browser = null;
let reloadRequested = false;
let stopping = false;

const say = (line) => process.stderr.write(`dev: ${line}\n`);

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit", ...options });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

async function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  await new Promise((resolve) => rl.question(prompt, resolve));
  rl.close();
}

const BUILD_STEPS = [
  ["pnpm", ["--filter", "@zenbu-labs/pixel", "build"]],
  ["pnpm", ["--filter", "@zenbu-labs/pixel", "build:native", "--", "--release"]],
  ["pnpm", ["-r", "--filter", "!./pixel/**", "build"]],
];

async function build() {
  while (true) {
    say("building");
    let failed = false;
    for (const [command, args] of BUILD_STEPS) {
      if ((await run(command, args)) !== 0) {
        failed = true;
        break;
      }
    }
    if (!failed) return;
    if (stopping) return;
    await waitForEnter("dev: build failed, press enter to retry ");
  }
}

function startBrowser() {
  browser = spawn(process.execPath, [CLI, "open", ...browserArgs], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, TERMINAL_BROWSER_DEV_SOCKET: SOCKET },
  });
  return new Promise((resolve) => {
    browser.on("exit", (code) => {
      browser = null;
      resolve(code ?? 0);
    });
  });
}

async function reload() {
  say("reloading");
  await run(process.execPath, [CLI, "shutdown"]);
  await build();
}

function listenForReload() {
  fs.rmSync(SOCKET, { force: true });
  const server = net.createServer((connection) => {
    let buffer = "";
    connection.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\n")) return;
      if (buffer.trim() === "reload" && browser && !reloadRequested) {
        reloadRequested = true;
        browser.kill("SIGTERM");
      }
      connection.end();
    });
    connection.on("error", () => {});
  });
  server.on("error", (error) => {
    say(`could not listen on ${SOCKET}: ${error.message}`);
    process.exit(1);
  });
  server.listen(SOCKET);
  server.unref();
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    stopping = true;
    browser?.kill(signal);
  });
}
process.on("exit", () => fs.rmSync(SOCKET, { force: true }));

listenForReload();
await build();
while (!stopping) {
  const code = await startBrowser();
  if (!reloadRequested) process.exit(code);
  reloadRequested = false;
  await reload();
}
