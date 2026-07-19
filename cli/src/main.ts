#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { detectBackend, setPaneTitle } from "pixel-terminals";
import type { Backend, Direction, Pane } from "pixel-terminals";
import { control } from "./control";
import { instances } from "./registry";
import type { InstanceRecord } from "./registry";


const HELP = `pixel — control pixel browsers running in your terminal

usage: pixel <command> [args]

  open [url] [--dir d]      open a browser in a new split (d: right|left|down|up;
                            --size f: pane fraction 0.2-0.95, ghostty only);
                            if a browser is already in this tab, opens the url
                            as a new active tab in it (--split forces a new split)
                            (--here: run it in the current pane instead,
                            blocking until the browser quits)
                            (--isolated: dedicated browser process with its own
                            chromium profile instead of the shared daemon)
                            (--palette-key k: rebind the command palette,
                            default super+p; --find-key k: rebind find in page,
                            default super+f; --action-mods m: rebind the
                            modifiers of the action shortcuts (screenshot,
                            record, ...), default super+shift. "none" disables)
  help                      show this help

All output is JSON. Browsers are matched to tabs by their pane title (pixel-browser:<pid>).
`;

interface LocatedInstance extends InstanceRecord {
  window: string | null;
  tab: string | null;
  inCurrentTab: boolean;
}

const TITLE_PATTERN = /pixel-browser:([\w-]+)/;

function recordKey(record: InstanceRecord): string {
  return record.key ?? String(record.pid);
}

function locate(records: InstanceRecord[], panes: Pane[]): LocatedInstance[] {
  const self = panes.find((pane) => pane.self);
  const byKey = new Map<string, Pane>();
  for (const pane of panes) {
    const match = TITLE_PATTERN.exec(pane.title);
    if (match) byKey.set(match[1], pane);
  }
  return records.map((record) => {
    const pane = byKey.get(recordKey(record));
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
  const electron = path.join(browserDir, "node_modules", ".bin", "electron");
  const main = path.join(browserDir, "dist", "main.js");
  for (const required of [electron, main]) {
    if (!fs.existsSync(required)) {
      fail(`missing ${required} — build the browser first (pnpm --filter pixel-browser build)`);
    }
  }
  const logDir = path.join(os.homedir(), ".pixel-browser", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const quoted = [electron, main, ...argv]
    .map((arg) => `'${arg.replaceAll("'", `'\\''`)}'`)
    .join(" ");
  // stray chromium/electron stderr lines scroll the pty and misalign the
  // engine's drawing under tmux, so the launcher keeps fd 2 off the terminal
  const line = `exec ${quoted} 2>>'${logDir.replaceAll("'", `'\\''`)}/stderr.log'`;
  return { command: ["/bin/sh", "-c", line], cwd: browserDir };
}

/** The pane command for `pixel open` splits: the thin client that attaches
 * this pane's tty to the shared browser daemon. */
function clientLaunchCommand(argv: string[]): { command: string[]; cwd: string } {
  const cli = path.resolve(__dirname, "main.js");
  const quoted = [process.execPath, cli, "open", "--here", ...argv]
    .map((arg) => `'${arg.replaceAll("'", `'\\''`)}'`)
    .join(" ");
  return { command: ["/bin/sh", "-c", `exec ${quoted}`], cwd: process.cwd() };
}

const DAEMON_SOCKET = path.join(os.homedir(), ".pixel-browser", "daemon.sock");

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

/** Attach this pane to the shared daemon: hand over the tty, then idle as the
 * pane's process forwarding resizes until the session ends. */
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
  if (!isolated) {
    try {
      return await attachHere(argv);
    } catch (error) {
      process.stderr.write(`pixel: daemon attach failed (${String(error)}); running isolated\n`);
    }
  }
  const { command, cwd } = browserLaunchCommand(argv);
  const child = spawn(command[0], command.slice(1), { cwd, stdio: "inherit" });
  const code: number = await new Promise((resolve) =>
    child.on("exit", (status) => resolve(status ?? 0)),
  );
  process.exit(code);
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

let cachedScale: number | null = null;

function displayScale(): number {
  if (cachedScale !== null) return cachedScale;
  try {
    const out = execFileSync(
      "osascript",
      ["-l", "JavaScript", "-e", "ObjC.import('AppKit'); $.NSScreen.mainScreen.backingScaleFactor"],
      { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    const scale = Number(out);
    cachedScale = Number.isFinite(scale) && scale > 0 ? scale : 2;
  } catch {
    cachedScale = 2;
  }
  return cachedScale;
}

/** a fresh split is 50/50; grow the new pane toward the requested fraction of
 * the space the two panes share (viewport is device px, resize takes points) */
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
  const deltaPoints = ((2 * size - 1) * current) / displayScale();
  const grow: Record<Direction, Direction> = {
    right: "left",
    left: "right",
    down: "up",
    up: "down",
  };
  await backend.resizePane(`pixel-browser:${recordKey(record)}`, grow[direction], deltaPoints);
}

async function launchInSplit(
  backend: Backend,
  direction: Direction,
  argv: string[],
  size?: number | null,
): Promise<InstanceRecord> {
  const before = new Set(instances().map(recordKey));
  const { command, cwd } = clientLaunchCommand(argv);
  await backend.split(direction, command, cwd);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const fresh = instances().find((record) => !before.has(recordKey(record)));
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
    const records = instances();
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
  // --here needs no terminal backend: it runs the browser on this tty
  if (command === "open" && takeBoolFlag(args, "--here")) {
    return openHere(args);
  }
  if (command === "open") {
    return openCommand(detectBackend(), args);
  }
  fail(`unknown command: ${command}\n\n${HELP}`);
}

void main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
