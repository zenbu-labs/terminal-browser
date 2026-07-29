#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { DAEMON_SOCKET, LOGS_DIR, ensureDataDir } from "pixel-store";
import {
  callerTty,
  checkKittyGraphics,
  detectBackend,
  prepareTmux,
  setPaneTitle,
  unsupportedGraphicsMessage,
} from "pixel-terminals";
import type { Backend, Direction } from "pixel-terminals";
import { actionCommand } from "./action";
import { control } from "./control";
import { setupCommand } from "./editors";
import { commandHelp, helpTopics, rootHelp } from "./help";
import { locate, recordKey, reusable } from "./instances";
import { lsCommand } from "./ls";
import { instances } from "./registry";
import type { InstanceRecord } from "./registry";

const DIST_ROOT = process.env.TERMINAL_BROWSER_DIST_ROOT ?? null;
delete process.env.ELECTRON_RUN_AS_NODE;

function fail(message: string): never {
  process.stderr.write(`terminal-browser: ${message}\n`);
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

function setuidHelperUsable(electron: string): boolean {
  const dir = path.dirname(electron);
  for (const helper of [
    path.join(dir, "chrome-sandbox"),
    path.join(dir, "..", "electron", "dist", "chrome-sandbox"),
  ]) {
    try {
      const stat = fs.statSync(helper);
      if (stat.uid === 0 && (stat.mode & 0o4000) !== 0) return true;
    } catch {}
  }
  return false;
}

function userNamespacesAllowed(): boolean {
  try {
    execFileSync("unshare", ["--user", "true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// chromium refuses to start rather than drop its sandbox, and an unprivileged install
// cannot give chrome-sandbox the root-owned setuid bit its helper sandbox needs
function sandboxArgs(electron: string): string[] {
  if (setuidHelperUsable(electron)) return [];
  return userNamespacesAllowed() ? ["--disable-setuid-sandbox"] : ["--no-sandbox"];
}

// the page is painted offscreen, so on a machine with no display chromium should not
// go looking for one — it dies on the way there
function electronArgs(electron: string): string[] {
  if (process.platform !== "linux") return [];
  const headless =
    process.env.DISPLAY || process.env.WAYLAND_DISPLAY ? [] : ["--ozone-platform=headless"];
  return [...sandboxArgs(electron), ...headless];
}

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
      fail(`missing ${required} — build the browser first (pnpm --filter terminal-browser build)`);
    }
  }
  ensureDataDir();
  const logDir = LOGS_DIR;
  fs.mkdirSync(logDir, { recursive: true });
  const quoted = [electron, ...electronArgs(electron), main, ...argv]
    .map((arg) => `'${arg.replaceAll("'", `'\\''`)}'`)
    .join(" ");
  const line = `exec ${quoted} 2>>'${logDir.replaceAll("'", `'\\''`)}/stderr.log'`;
  return { command: ["/bin/sh", "-c", line], cwd: browserDir };
}

function clientLaunchCommand(argv: string[]): { command: string[]; cwd: string } {
  const runner = DIST_ROOT
    ? [path.join(DIST_ROOT, "bin", "terminal-browser")]
    : [process.execPath, path.resolve(__dirname, "main.js")];
  const quoted = [...runner, "open", ...argv]
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

function interactiveTty(): string | null {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  return ownTtyPath();
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
    cwd: process.cwd(),
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
  // the title marker is how terminal-browser commands find this pane
  setPaneTitle(tty, `terminal-browser:${reply.session}`);
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
  prepareTmux();
  const isolated = takeBoolFlag(argv, "--isolated");
  if (!isolated) {
    try {
      return await attachHere(argv);
    } catch (error) {
      process.stderr.write(`terminal-browser: daemon attach failed (${String(error)}); running isolated\n`);
    }
  }
  const { command, cwd } = browserLaunchCommand([...argv, `--cwd=${process.cwd()}`]);
  const child = spawn(command[0], command.slice(1), { cwd, stdio: "inherit" });
  const code: number = await new Promise((resolve) =>
    child.on("exit", (status) => resolve(status ?? 0)),
  );
  process.exit(code);
}

const DIRECTIONS: Direction[] = ["right", "left", "down", "up"];

function isDirection(value: string): value is Direction {
  return (DIRECTIONS as string[]).includes(value);
}

function takeDirection(args: string[]): { direction: Direction; explicit: boolean } {
  const flag = takeFlag(args, "--dir");
  if (flag !== undefined && !isDirection(flag)) fail(`invalid --dir ${flag} (right|left|down|up)`);
  const filler = args.indexOf("split");
  if (filler >= 0) args.splice(filler, 1);
  const wordAt = args.findIndex(isDirection);
  const word = wordAt >= 0 ? (args.splice(wordAt, 1)[0] as Direction) : undefined;
  const direction = (flag as Direction | undefined) ?? word;
  return { direction: direction ?? "right", explicit: direction !== undefined };
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
  await backend.resizePane(`terminal-browser:${recordKey(record)}`, grow[direction], deltaPoints);
}

async function launchInSplit(
  backend: Backend,
  direction: Direction,
  argv: string[],
  size?: number | null,
): Promise<InstanceRecord> {
  const before = new Set((await instances()).map(recordKey));
  const { command, cwd } = clientLaunchCommand(argv);
  await backend.split(direction, command, cwd, size);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const fresh = (await instances()).find((record) => !before.has(recordKey(record)));
    if (fresh) {
      if (size) await applySplitSize(backend, direction, fresh, size).catch(() => {});
      return fresh;
    }
    await sleep(250);
  }
  fail("browser did not register within 20s (is the split open?)");
}

// the browser paints the page as an image in the pane, so a terminal without the
// kitty graphics protocol can launch it but never show it — refuse up front
async function requireKittyGraphics() {
  // passthrough has to be on before we can probe through tmux
  prepareTmux();
  if ((await checkKittyGraphics()) !== "unsupported") return;
  // not fail(): this one stands on its own, without the command-name prefix
  process.stderr.write(unsupportedGraphicsMessage(process.stderr.isTTY === true));
  process.exit(1);
}

// slop fixme
// these options are very poorly designed
async function openCommand(args: string[]) {
  const forceSplit = takeBoolFlag(args, "--split");
  const { direction, explicit } = takeDirection(args);
  const size = takeSizeFlag(args);
  const paletteKey = takeKeyBinding(args, "--palette-key");
  const findKey = takeKeyBinding(args, "--find-key");
  const actionMods = takeModsBinding(args, "--action-mods");
  const bindings: string[] = [];
  if (paletteKey) bindings.push(`--palette-key=${paletteKey}`);
  if (findKey) bindings.push(`--find-key=${findKey}`);
  if (actionMods) bindings.push(`--action-mods=${actionMods}`);
  if (isSshSession() && (forceSplit || explicit || size !== null)) {
    fail("split options are unavailable over SSH because terminal-browser runs in the current pane");
  }
  await requireKittyGraphics();
  if (isSshSession() || (!forceSplit && !explicit && interactiveTty())) {
    return openHere([...args, ...bindings]);
  }
  const backend = detectBackend();
  const url = args[0];
  const tty = ownTtyPath() ?? callerTty();
  if (!forceSplit) {
    const records = await instances();
    if (records.length > 0) {
      const found = locate(records, await backend.panes());
      const target = reusable(found, explicit ? direction : null, tty);
      if (target) {
        return print(
          await control(
            target.socket,
            url ? { cmd: "open-tab", url, cwd: process.cwd() } : { cmd: "open-tab" },
          ),
        );
      }
    }
  }
  const argv = url ? [url] : [];
  argv.push(`--split-dir=${direction}`);
  if (tty) argv.push(`--parent-tty=${tty}`);
  argv.push(...bindings);
  print(await launchInSplit(backend, direction, argv, size));
}

function isSshSession(): boolean {
  return Boolean(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY);
}

function splitPassthrough(args: string[]): { own: string[]; passthrough: string[] } {
  const at = args.indexOf("--");
  if (at < 0) return { own: args, passthrough: [] };
  return { own: args.slice(0, at), passthrough: args.slice(at + 1) };
}

function takeTabFlag(args: string[]): number | undefined {
  const raw = takeFlag(args, "--tab");
  if (raw === undefined) return undefined;
  const id = Number(raw.replace(/^t/, ""));
  if (!Number.isInteger(id)) fail(`invalid --tab ${raw} (a tab id from terminal-browser ls)`);
  return id;
}

function asksForHelp(args: string[]): boolean {
  const end = args.indexOf("--");
  const own = end < 0 ? args : args.slice(0, end);
  return own.includes("--help") || own.includes("-h");
}

function helpCommand(topic: string | undefined): number {
  if (!topic) {
    process.stdout.write(rootHelp());
    return 0;
  }
  const help = commandHelp(topic);
  if (!help) fail(`no help for ${topic} (try ${helpTopics().join(", ")})`);
  process.stdout.write(help);
  return 0;
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(rootHelp());
    return 0;
  }
  if (command === "help") return helpCommand(args[0]);
  if (asksForHelp(args)) {
    const help = commandHelp(command);
    if (help) {
      process.stdout.write(help);
      return 0;
    }
  }
  if (command === "open") {
    await openCommand(args);
    return 0;
  }
  if (command === "ls") {
    const all = takeBoolFlag(args, "--all");
    const json = takeBoolFlag(args, "--json");
    await lsCommand(detectBackend(), all, json);
    return 0;
  }
  if (command === "setup") return setupCommand();
  if (command === "action") {
    const { own, passthrough } = splitPassthrough(args);
    const options = {
      browserKey: takeFlag(own, "--browser"),
      tabId: takeTabFlag(own),
      targetId: takeFlag(own, "--target"),
      follow: takeBoolFlag(own, "--follow"),
      resolve: takeBoolFlag(own, "--resolve"),
      printEnv: takeBoolFlag(own, "--env"),
      passthrough,
    };
    if (own.length > 0) fail(`unexpected ${own[0]} — put agent-browser arguments after --`);
    return actionCommand(detectBackend(), options);
  }
  fail(`unknown command: ${command}\n\n${rootHelp()}`);
}

void main()
  .then((code) => {
    if (code) process.exit(code);
  })
  .catch((error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
  });
