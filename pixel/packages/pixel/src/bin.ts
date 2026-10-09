#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { announceGuest, findOwner, waitForOwners } from "./instances";
import { apparmorSetup, linuxSandboxError } from "./sandbox";
import { TERMUX_CHROMIUM_FLAGS, checkTerminal, detect, inTermux, termuxEnv, unsupportedGraphicsMessage } from "./terminal";

function fail(message: string): never {
  process.stderr.write(`pixel: ${message}\n`);
  process.exit(1);
}

function resolveEntry(given: string): string {
  const target = path.resolve(given);
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    const manifest = path.join(target, "package.json");
    let main = "index.js";
    if (fs.existsSync(manifest)) {
      const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { main?: string };
      if (parsed.main) main = parsed.main;
    }
    const entry = path.join(target, main);
    if (!fs.existsSync(entry)) {
      fail(`${entry} does not exist. Build your app or point "main" in package.json at the built entry.`);
    }
    return entry;
  }
  if (!fs.existsSync(target)) fail(`no such file ${target}`);
  return target;
}

function appName(dir: string): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: string };
    if (parsed.name) return parsed.name.replace(/^@/, "").replace("/", "-");
  } catch {}
  return path.basename(dir);
}

function appDir(entry: string): string {
  for (let dir = path.dirname(entry); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    if (path.dirname(dir) === dir) return path.dirname(entry);
  }
}

function electronBinary(): string {
  const dist = path.resolve(__dirname, "..", "electron", "dist");
  if (!fs.existsSync(path.join(dist, ".zenbu-electron-sha256"))) {
    fail(
      "the patched electron build is not installed. Run `node node_modules/@zenbu-labs/pixel/scripts/postinstall.mjs` (npm normally runs it for you on install).",
    );
  }
  return process.platform === "darwin"
    ? path.join(dist, "Electron.app", "Contents", "MacOS", "pixel")
    : path.join(dist, "pixel");
}

function logFile(appDir: string): string {
  const state = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  const dir = path.join(state, "pixel", "logs");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${path.basename(appDir)}.stderr.log`);
}

function ownTty(): string {
  try {
    const out = execFileSync("tty", { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8" }).trim();
    if (out.startsWith("/dev/")) return out;
  } catch {}
  return fail("could not work out which tty this shell is on");
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const passthrough = args.indexOf("--");
  const own = passthrough < 0 ? args : args.slice(0, passthrough);
  const appArgs = passthrough < 0 ? [] : args.slice(passthrough + 1);
  if (own.includes("--help") || own.includes("-h")) {
    process.stdout.write(
      "usage: pixel [entry|dir] [-- app args]\n  Runs an app's main file inside the pixel runtime, in this terminal pane.\n",
    );
    return 0;
  }
  const stray = own.slice(1).find((arg) => arg.startsWith("-")) ?? own.find((arg) => arg.startsWith("-"));
  if (stray) {
    fail(`unknown option ${stray}. pixel takes an entry and nothing else; put your app's arguments after --`);
  }
  if (own.length > 1) fail(`unexpected ${own[1]}; put your app's arguments after --`);
  const entry = resolveEntry(own[0] ?? ".");

  const tty = process.env.PIXEL_TTY ?? ownTty();
  const owner = findOwner(tty);
  const announced = owner ? announceGuest(owner, appName(appDir(entry))) : null;
  if (!owner && !process.env.PIXEL_EMBED) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      fail("tty required");
    }
    const check = await checkTerminal(detect());
    if (check.graphics === "unsupported") {
      process.stderr.write(unsupportedGraphicsMessage(process.stderr.isTTY === true));
      return 1;
    }
  }

  const electron = electronBinary();
  const chromiumArgs: string[] = [];
  if (inTermux()) {
    chromiumArgs.push(...TERMUX_CHROMIUM_FLAGS);
  } else if (process.platform === "linux") {
    let sandboxError = linuxSandboxError(electron);
    if (sandboxError) {
      apparmorSetup(electron);
      sandboxError = linuxSandboxError(electron);
    }
    if (sandboxError) fail(sandboxError);
  }
  // headless ozone reports a 1x1 screen unless told otherwise:
  // https://source.chromium.org/chromium/chromium/src/+/refs/tags/150.0.7871.212:ui/ozone/platform/headless/headless_screen.cc;l=37-46
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    chromiumArgs.push("--ozone-platform=headless", "--screen-info={8192x8192}");
  }

  const bootstrap = path.join(__dirname, "bootstrap.js");
  const env = inTermux() ? termuxEnv(process.env) : { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.PIXEL_TTY = tty;
  if (announced) env.PIXEL_PANE = announced.pane;
  else delete env.PIXEL_PANE;
  const stderr = fs.openSync(logFile(appDir(entry)), "a");
  const child = spawn(electron, [bootstrap, entry, ...chromiumArgs, ...appArgs], {
    stdio: ["inherit", "inherit", stderr],
    env,
  });
  const forward = (signal: NodeJS.Signals) => () => {
    try {
      child.kill(signal);
    } catch {}
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, 2000).unref();
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, forward(signal));
  const exited = await new Promise<number>((resolve) => {
    child.on("error", (error) => {
      process.stderr.write(`pixel: could not start electron: ${error.message}\n`);
      resolve(1);
    });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 0)));
  });
  await waitForOwners(tty);
  return exited;
}

void main().then(
  (code) => process.exit(code),
  (error: unknown) => fail(error instanceof Error ? error.message : String(error)),
);
