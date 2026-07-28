#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { DAEMON_SOCKET, LOGS_DIR, ensureDataDir } from "pixel-store";
import { detectBackend, setPaneTitle } from "pixel-terminals";
import type { Backend, Direction, Pane } from "pixel-terminals";
import { control } from "./control";
import { instances } from "./registry";
import type { InstanceRecord } from "./registry";

const DIST_ROOT = process.env.PIXEL_DIST_ROOT ?? null;
delete process.env.ELECTRON_RUN_AS_NODE;

const HELP = `
Usage: pixel <command> [args]

  open [url] [options]   Open a browser in a new split or tab.

    Options:
      --dir <direction>     Split direction: right, left, down, up
      --size <fraction>     Pane size (0.2-0.95)
      --split               Force new split even if browser exists
      --here                Run in current pane, block until close
      --isolated            Use dedicated browser process/profile
      --palette-key <key>   Command palette key (default: super+p)
      --find-key <key>      Find-in-page key (default: super+f)
      --action-mods <mods>  Action shortcut mods (default: super+shift, "none" disables)

  help                  Show this help
`;

interface LocatedInstance extends InstanceRecord {
  window: string | null;
  tab: string | null;
  inCurrentTab: boolean;
}

const TITLE_PATTERN = /pixel-browser:([\w-]+)/;

function locate(records: InstanceRecord[], panes: Pane[]): LocatedInstance[] {
  const self = panes.find((pane) => pane.self);
  const byKey = new Map<string, Pane>();
  for (const pane of panes) {
    const match = TITLE_PATTERN.exec(pane.title);
    if (match) byKey.set(match[1], pane);
  }
  return records.map((record) => {
    const pane = byKey.get(record.key);
    return {
      ...record,
      window: pane?.window ?? null,
      tab: pane?.tab ?? null,
      inCurrentTab:
        !!pane && !!self && pane.window === self.window && pane.tab === self.tab,
    };
  });
}

function fail(message: string): never {
  process.stderr.write(`pixel: ${message}\n`);
  process.exit(1);
}

function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function takeFlag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined) fail(`${name} requires a value`);
  args.splice(at, 2);
  return value;
}

function takeBoolFlag(args: string[], name: string): boolean {
  const at = args.indexOf(name);
  if (at < 0) return false;
  args.splice(at, 1);
  return true;
}

const BINDING_MODS = ["cmd", "super", "ctrl", "alt", "option", "shift"];

function takeKeyBinding(args: string[], flag: string, fallback?: string): string | undefined {
  const spec = takeFlag(args, flag) ?? fallback;
  if (spec === undefined || spec === "none") return spec;
  const parts = spec.toLowerCase().split("+");
  const key = parts.pop();
  if (!key || key.length !== 1 || parts.length === 0 || parts.some((part) => !BINDING_MODS.includes(part))) {
    fail(`invalid ${flag} ${spec} (e.g. super+alt+p, ctrl+shift+p, or none to disable)`);
  }
  return spec;
}

function takeModsBinding(args: string[], flag: string, fallback?: string): string | undefined {
  const spec = takeFlag(args, flag) ?? fallback;
  if (spec === undefined || spec === "none") return spec;
  const parts = spec.toLowerCase().split("+");
  if (parts.length === 0 || parts.some((part) => !BINDING_MODS.includes(part))) {
    fail(`invalid ${flag} ${spec} (modifiers only, e.g. super+alt+shift, or none to disable)`);
  }
  return spec;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function browserLaunchCommand(argv: string[]): { command: string[]; cwd: string } {
  const browserDir = path.resolve(__dirname, "..", "..", "browser");
  const electron = DIST_ROOT
    ? process.platform === "darwin"
      ? path.join(DIST_ROOT, "electron", "Pixel.app", "Contents", "MacOS", "Pixel")
      : path.join(DIST_ROOT, "electron", "electron")
    : path.join(browserDir, "node_modules", ".bin", "electron");
  const main = path.join(browserDir, "dist", "main.js");
  for (const required of [electron, main]) {
    if (!fs.existsSync(required)) {
      fail(`missing ${required} — build the browser first (pnpm --filter pixel-browser build)`);
    }
  }
  ensureDataDir();
  const logDir = LOGS_DIR;
  fs.mkdirSync(logDir, { recursive: true });
  const quoted = [electron, main, ...argv]
    .map((arg) => `'${arg.replaceAll("'", `'\\''`)}'`)
    .join(" ");
  const line = `exec ${quoted} 2>>'${logDir.replaceAll("'", `'\\''`)}/stderr.log'`;
  return { command: ["/bin/sh", "-c", line], cwd: browserDir };
}

function clientLaunchCommand(argv: string[]): { command: string[]; cwd: string } {
  const runner = DIST_ROOT
    ? [path.join(DIST_ROOT, "bin", "pixel")]
    : [process.execPath, path.resolve(__dirname, "main.js")];
  const quoted = [...runner, "open", "--here", ...argv]
    .map((arg) => `'${arg.replaceAll("'", `'\\''`)}'`)
    .join(" ");
  return { command: ["/bin/sh", "-c", `exec ${quoted}`], cwd: process.cwd() };
}

function ownTtyPath(): string | null {
  try {
    const out = execFileSync("tty", {
      stdio: ["inherit", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    return out.startsWith("/dev/") ? out : null;
  } catch {
    return null;
  }
}

function browserBuildStamp(): string {
  const main = path.resolve(__dirname, "..", "..", "browser", "dist", "main.js");
  try {
    return String(Math.floor(fs.statSync(main).mtimeMs));
  } catch {
    return "unknown";
  }
}

function connectDaemon(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(DAEMON_SOCKET);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function spawnDaemon() {
  const { command, cwd } = browserLaunchCommand(["--daemon"]);
  const child = spawn(command[0], command.slice(1), { cwd, detached: true, stdio: "ignore" });
  child.unref();
}

async function daemonSocket(): Promise<net.Socket> {
  try {
    return await connectDaemon();
  } catch {}
  spawnDaemon();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      return await connectDaemon();
    } catch {
      await sleep(200);
    }
  }
  throw new Error("daemon did not start");
}

interface DaemonReply {
  ok?: boolean;
  error?: string;
  session?: string;
  event?: string;
  code?: number;
}

function nextReply(socket: net.Socket, onLine: (reply: DaemonReply) => void): void {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      try {
        onLine(JSON.parse(line) as DaemonReply);
      } catch {}
    }
  });
}


async function openSession(argv: string[], tty: string): Promise<{ socket: net.Socket; reply: DaemonReply }> {
  const request = `${JSON.stringify({
    cmd: "open",
    tty,
    argv,
    env: process.env,
    build: browserBuildStamp(),
  })}\n`;
  const ask = (socket: net.Socket) =>
    new Promise<DaemonReply>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("daemon open timed out")), 20_000);
      nextReply(socket, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      socket.once("close", () => {
        clearTimeout(timer);
        reject(new Error("daemon closed the connection"));
      });
      socket.write(request);
    });
  let socket = await daemonSocket();
  let reply = await ask(socket);
  if (reply.ok === false && reply.error === "stale") {
    // the stale daemon steps aside when idle; give it a beat and respawn
    socket.destroy();
    await sleep(700);
    socket = await daemonSocket();
    reply = await ask(socket);
  }
  return { socket, reply };
}

async function attachHere(argv: string[]): Promise<never> {
  const tty = ownTtyPath();
  if (!tty) throw new Error("not running on a tty");
  const { socket, reply } = await openSession(argv, tty);
  if (reply.ok === false || !reply.session) {
    socket.destroy();
    throw new Error(reply.error ?? "daemon refused the session");
  }
  // the title marker is how pixel commands find this pane
  setPaneTitle(tty, `pixel-browser:${reply.session}`);
  nextReply(socket, (message) => {
    if (message.event === "closed") process.exit(message.code ?? 0);
  });
  socket.on("close", () => process.exit(0));
  socket.on("error", () => process.exit(1));
  process.on("SIGWINCH", () => {
    try {
      socket.write('{"cmd":"resize"}\n');
    } catch {}
  });
  const requestClose = () => {
    try {
      socket.write('{"cmd":"close"}\n');
    } catch {
      process.exit(0);
    }
    setTimeout(() => process.exit(0), 2000);
  };
  process.on("SIGINT", requestClose);
  process.on("SIGTERM", requestClose);
  return new Promise<never>(() => {});
}

async function openHere(argv: string[]): Promise<never> {
  const isolated = takeBoolFlag(argv, "--isolated");
  if (!isolated) return attachHere(argv);
  const { command, cwd } = browserLaunchCommand(argv);
  const child = spawn(command[0], command.slice(1), { cwd, stdio: "inherit" });
  const code: number = await new Promise((resolve) =>
    child.on("exit", (status) => resolve(status ?? 0)),
  );
  process.exit(code);
}

function isSshSession(): boolean {
  return !!(
    process.env.SSH_CONNECTION ||
    process.env.SSH_CLIENT ||
    process.env.SSH_TTY
  );
}

function openOverSsh(args: string[]): Promise<never> {
  for (const flag of ["--dir", "--size", "--split"]) {
    if (args.includes(flag)) {
      fail(`${flag} is unavailable over SSH because Pixel runs in the current SSH pane`);
    }
  }
  return openHere(args);
}

function takeDirection(args: string[]): Direction {
  const direction = (takeFlag(args, "--dir") ?? "right") as Direction;
  if (!["right", "left", "down", "up"].includes(direction)) {
    fail(`invalid --dir ${direction} (right|left|down|up)`);
  }
  return direction;
}

function takeSizeFlag(args: string[]): number | null {
  const raw = takeFlag(args, "--size");
  if (raw === undefined || raw === null) return null;
  const size = Number(raw);
  if (!Number.isFinite(size) || size < 0.2 || size > 0.95) {
    fail(`invalid --size ${raw} (fraction between 0.2 and 0.95)`);
  }
  return size;
}

async function applySplitSize(
  backend: Backend,
  direction: Direction,
  record: InstanceRecord,
  size: number,
) {
  if (!backend.resizePane) return;
  const viewport = record.viewport;
  if (!viewport?.width || !viewport?.height) return;
  const horizontal = direction === "right" || direction === "left";
  const current = horizontal ? viewport.width : viewport.height;
  const deltaPoints = ((2 * size - 1) * current) / viewport.scale;
  const grow: Record<Direction, Direction> = {
    right: "left",
    left: "right",
    down: "up",
    up: "down",
  };
  await backend.resizePane(`pixel-browser:${record.key}`, grow[direction], deltaPoints);
}

async function launchInSplit(
  backend: Backend,
  direction: Direction,
  argv: string[],
  size?: number | null,
): Promise<InstanceRecord> {
  const before = new Set((await instances()).map((record) => record.key));
  const { command, cwd } = clientLaunchCommand(argv);
  await backend.split(direction, command, cwd);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const fresh = (await instances()).find((record) => !before.has(record.key));
    if (fresh) {
      if (size) await applySplitSize(backend, direction, fresh, size).catch(() => {});
      return fresh;
    }
    await sleep(250);
  }
  fail("browser did not register within 20s (is the split open?)");
}

async function openCommand(backend: Backend, args: string[]) {
  const forceSplit = takeBoolFlag(args, "--split");
  const direction = takeDirection(args);
  const size = takeSizeFlag(args);
  const paletteKey = takeKeyBinding(args, "--palette-key");
  const findKey = takeKeyBinding(args, "--find-key");
  const actionMods = takeModsBinding(args, "--action-mods");
  const url = args[0];
  if (!forceSplit) {
    const records = await instances();
    if (records.length > 0) {
      const located = locate(records, await backend.panes());
      const here = located.find((record) => record.inCurrentTab);
      if (here) {
        return print(await control(here.socket, url ? { cmd: "open-tab", url } : { cmd: "open-tab" }));
      }
    }
  }
  const argv = url ? [url] : [];
  if (paletteKey) argv.push(`--palette-key=${paletteKey}`);
  if (findKey) argv.push(`--find-key=${findKey}`);
  if (actionMods) argv.push(`--action-mods=${actionMods}`);
  print(await launchInSplit(backend, direction, argv, size));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (command === "open" && takeBoolFlag(args, "--here")) {
    return openHere(args);
  }
  if (command === "open" && isSshSession()) {
    return openOverSsh(args);
  }
  if (command === "open") {
    return openCommand(detectBackend(), args);
  }
  fail(`unknown command: ${command}\n\n${HELP}`);
}

void main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
