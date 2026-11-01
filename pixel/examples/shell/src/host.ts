import { spawnSync } from "node:child_process";
import fs from "node:fs";
import module from "node:module";

import type { IPty } from "node-pty";

import { fallback, launch } from "./terminal/launch";
import type { ZshLaunch } from "./terminal/launch";
import { logError, trace } from "./log";
import type { Shell } from "./terminal/shell";
import type { Ui } from "./ui/ui";

module.enableCompileCache?.();

function canDraw(): boolean {
  if (process.env.PXSH_FORCE) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  if (process.env.TMUX || process.env.STY) return false;
  const term = process.env.TERM ?? "";
  if (!term || term === "dumb") return false;
  return process.env.TERM_PROGRAM === "ghostty" || term === "xterm-ghostty" || term === "xterm-kitty" || !!process.env.KITTY_WINDOW_ID;
}

function becomePlainZsh(args: string[]): never {
  const plain = fallback(args);
  process.execve!(plain.file, [plain.argv0, ...plain.args], plain.env);
  process.exit(127);
}

const SETS_IUTF8_LIKE_GHOSTTY = { encoding: "utf8" } as const;

function spawnZsh(zsh: ZshLaunch, size: { cols: number; rows: number }): IPty {
  const pty = require("node-pty") as typeof import("node-pty");
  const spawned = pty.spawn(zsh.file, zsh.args, { name: process.env.TERM, cwd: zsh.cwd, env: zsh.env, ...SETS_IUTF8_LIKE_GHOSTTY, ...size });
  keepReadsAsRawBytes(spawned);
  return spawned;
}

function keepReadsAsRawBytes(spawned: IPty): void {
  const readable = (spawned as unknown as { _socket: { _readableState: { decoder: unknown; encoding: unknown } } })._socket._readableState;
  readable.decoder = null;
  readable.encoding = null;
}

function turnOffOutputProcessing(): void {
  spawnSync("/bin/stty", ["-opost"], { stdio: ["inherit", "ignore", "ignore"] });
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length || !canDraw()) becomePlainZsh(args);
  const size = { cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 };
  let zsh: ZshLaunch;
  let pty: IPty;
  try {
    zsh = launch();
    pty = spawnZsh(zsh, size);
  } catch (error) {
    trace("startup failed", String(error));
    becomePlainZsh([]);
  }
  process.stdin.setRawMode(true);
  turnOffOutputProcessing();
  let shell: Shell | null = null;
  let ui: Ui | null = null;
  const exit = (code: number) => {
    for (const step of [() => ui?.stop(), () => shell?.stop(), () => process.stdin.setRawMode(false), () => fs.rmSync(zsh.dir, { recursive: true, force: true })]) {
      try {
        step();
      } catch (error) {
        logError(error);
      }
    }
    process.exit(code);
  };
  const { Shell } = require("./terminal/shell") as typeof import("./terminal/shell");
  shell = new Shell(pty, zsh, size, exit);
  const { Ui } = require("./ui/ui") as typeof import("./ui/ui");
  ui = new Ui(shell);
  process.stdin.on("data", (data: Buffer) => shell!.input(data));
  process.stdout.on("resize", () => shell!.resize(process.stdout.columns, process.stdout.rows));
  const hangUp = () => {
    pty.kill("SIGHUP");
    exit(129);
  };
  process.stdin.on("end", hangUp);
  process.stdin.on("error", hangUp);
  process.on("SIGHUP", () => {
    pty.kill("SIGHUP");
    exit(129);
  });
  process.on("SIGTERM", () => {
    pty.kill("SIGHUP");
    exit(143);
  });
  process.on("uncaughtException", (error) => logError(error));
  shell.start();
}

main();
