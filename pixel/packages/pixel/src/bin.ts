#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { appExecutable } from "./app-executable";
import { announceGuest, findOwner, waitForOwners } from "./instances";
import { RELAUNCH_FD, RELAUNCH_FD_ENV, parseRelaunchRequest, type RelaunchRequest } from "./relaunch";
import { apparmorSetup, linuxSandboxError } from "./sandbox";
import { RENDERER_ENV, checkTerminal, detect } from "./terminal";

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

const TERMINAL_RESET =
  "\x1b\\\x1b[?2026l\x1b_Ga=d,d=A,q=2\x1b\\\x1b[>4;0m\x1b[?2031l\x1b[0m\x1b[0 q" +
  "\x1b[<u\x1b[?2048l\x1b[?2004l\x1b[?1004l\x1b[?1016l\x1b[?1006l\x1b[?1003l\x1b[?25h\x1b[?1049l";

function resetTerminal(tty: string | undefined) {
  let fd = 1;
  try {
    if (tty) fd = fs.openSync(tty, "w");
    fs.writeSync(fd, TERMINAL_RESET);
    execFileSync("stty", ["sane"], { stdio: [fd, "ignore", "ignore"] });
  } catch {}
  if (fd !== 1) fs.closeSync(fd);
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
  const override = process.env.PIXEL_ELECTRON_APP;
  if (override) {
    try {
      return appExecutable(override);
    } catch (error) {
      fail((error as Error).message);
    }
  }
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
  let renderer = process.env[RENDERER_ENV];
  if (!findOwner(tty) && !process.env.PIXEL_EMBED) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      fail("tty required");
    }
    if (!renderer && (await checkTerminal(detect())).graphics === "unsupported") renderer = "cells";
  }

  const electron = electronBinary();
  const chromiumArgs: string[] = [];
  if (process.platform === "linux") {
    let sandboxError = linuxSandboxError(electron);
    if (sandboxError) {
      apparmorSetup(electron);
      sandboxError = linuxSandboxError(electron);
    }
    if (sandboxError) fail(sandboxError);
    // headless ozone reports a 1x1 screen unless told otherwise:
    // https://source.chromium.org/chromium/chromium/src/+/refs/tags/150.0.7871.212:ui/ozone/platform/headless/headless_screen.cc;l=37-46
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      chromiumArgs.push("--ozone-platform=headless", "--screen-info={8192x8192}");
    }
  }

  const bootstrap = path.join(__dirname, "bootstrap.js");
  const log = logFile(appDir(entry));

  let child: ChildProcess | null = null;
  const forward = (signal: NodeJS.Signals) => () => {
    const target = child;
    try {
      target?.kill(signal);
    } catch {}
    setTimeout(() => {
      try {
        target?.kill("SIGKILL");
      } catch {}
    }, 2000).unref();
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, forward(signal));

  const launch = async (launchArgs: string[], extraEnv: Record<string, string>): Promise<{ code: number; relaunch: RelaunchRequest | null }> => {
    const owner = findOwner(tty);
    const announced = owner ? announceGuest(owner, appName(appDir(entry))) : null;
    const env = { ...process.env, ...extraEnv };
    delete env.ELECTRON_RUN_AS_NODE;
    env.PIXEL_TTY = tty;
    env[RELAUNCH_FD_ENV] = String(RELAUNCH_FD);
    if (renderer) env[RENDERER_ENV] = renderer;
    if (announced) env.PIXEL_PANE = announced.pane;
    else delete env.PIXEL_PANE;
    const stderr = fs.openSync(log, "a");
    const spawned = spawn(electron, [bootstrap, entry, ...chromiumArgs, ...launchArgs], {
      stdio: ["inherit", "inherit", stderr, "pipe"],
      env,
    });
    child = spawned;
    let requested = "";
    spawned.stdio[RELAUNCH_FD]?.on("data", (chunk: Buffer) => (requested += chunk.toString("utf8")));
    const code = await new Promise<number>((resolve) => {
      spawned.on("error", (error) => {
        process.stderr.write(`pixel: could not start electron: ${error.message}\n`);
        resolve(1);
      });
      spawned.on("close", (code, signal) => {
        if (signal && !owner && !process.env.PIXEL_EMBED) resetTerminal(tty);
        if (code) {
          process.stderr.write(`pixel crashed (exit code ${code}). Full logs: ${log}\n`);
        }
        resolve(code ?? (signal ? 128 : 0));
      });
    });
    fs.closeSync(stderr);
    announced?.end();
    return { code, relaunch: requested ? parseRelaunchRequest(requested) : null };
  };

  let run = await launch(appArgs, {});
  while (run.relaunch) run = await launch(run.relaunch.args, run.relaunch.env ?? {});
  const exited = run.code;
  await waitForOwners(tty);
  return exited;
}

void main().then(
  (code) => process.exit(code),
  (error: unknown) => fail(error instanceof Error ? error.message : String(error)),
);
