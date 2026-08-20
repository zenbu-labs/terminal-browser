#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import {
  DAEMON_SOCKET,
  LOGS_DIR,
  ensureDataDir,
  findProfile,
  profileSettings,
  saveProfile,
} from "pixel-store";
import {
  callerTty,
  canSplit,
  cannotOpenPanes,
  checkTerminal,
  detect,
  unsupportedGraphicsMessage,
} from "pixel-terminals";
import type { Direction, Terminal, TerminalCheck } from "pixel-terminals";
import { actionCommand } from "./action";
import { control } from "./control";
import { setupCommand } from "./editors";
import { browsers, describe, recordKey } from "./instances";
import type { Browser } from "./instances";
import { keybindingsCommand } from "./keybindings-command";
import { lsCommand } from "./ls";
import { namedProfileName } from "./profile";
import type { ImportResult } from "./profile";
import { profileCommand } from "./profile-command";
import { runCli } from "./program";
import type { CliActions, OpenRequest } from "./program";
import { instances } from "./registry";
import { apparmorSetup, deniedRefusal, linuxSandboxError, sandboxRefusal } from "./sandbox";
import type { InstanceRecord } from "./registry";
import { installedVersion, upgradeCommand } from "./upgrade";

const DIST_ROOT = process.env.TERMINAL_BROWSER_DIST_ROOT ?? null;
delete process.env.ELECTRON_RUN_AS_NODE;

function fail(message: string): never {
  process.stderr.write(`terminal-browser: ${message}\n`);
  process.exit(1);
}

function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ELECTRON_DIST_BIN =
  process.platform === "darwin"
    ? ["terminal-browser.app", "Contents", "MacOS", "terminal-browser"]
    : ["electron"];
const ELECTRON_DEV_BIN =
  process.platform === "darwin"
    ? ["Electron.app", "Contents", "MacOS", "Electron"]
    : ["electron"];

function browserDirectory(): string {
  return path.resolve(__dirname, "..", "..", "browser");
}

function electronBinary(): string {
  return DIST_ROOT
    ? path.join(DIST_ROOT, "electron", ...ELECTRON_DIST_BIN)
    : path.join(browserDirectory(), "node_modules", "electron", "dist", ...ELECTRON_DEV_BIN);
}

function browserLaunchCommand(argv: string[]): { command: string[]; cwd: string } {
  const browserDir = browserDirectory();
  const electron = electronBinary();
  const main = browserMain();
  for (const required of [electron, main]) {
    if (!fs.existsSync(required)) {
      fail(`missing ${required} — build the browser first (pnpm --filter terminal-browser build)`);
    }
  }
  if (process.platform === "linux") {
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
    argv = [...argv, "--ozone-platform=headless", "--screen-info={8192x8192}"];
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

function browserMain(): string {
  return path.join(browserDirectory(), "dist", "main.js");
}

async function runCookieImport(
  file: string,
  partition: string,
  replace: boolean,
): Promise<ImportResult> {
  const args = [browserMain(), `--import-cookies=${file}`, `--partition=${partition}`];
  if (replace) args.push("--replace-cookies");
  return JSON.parse(await runBrowserUtility(args)) as ImportResult;
}

async function runProfileRemoval(partition: string): Promise<boolean> {
  const result = JSON.parse(
    await runBrowserUtility([browserMain(), `--remove-partition=${partition}`]),
  ) as { removed?: boolean };
  return result.removed === true;
}

async function runBrowserUtility(args: string[]): Promise<string> {
  let daemonRunning = false;
  try {
    const socket = await connectDaemon();
    socket.destroy();
    daemonRunning = true;
  } catch {}
  if (daemonRunning) fail("stop the terminal-browser daemon before changing a profile");
  const electron = electronBinary();
  for (const required of [electron, browserMain()]) {
    if (!fs.existsSync(required)) {
      fail(`missing ${required} — build the browser first (pnpm --filter terminal-browser build)`);
    }
  }
  if (process.platform === "linux") {
    let sandboxError = linuxSandboxError(electron);
    if (sandboxError) {
      apparmorSetup(electron);
      sandboxError = linuxSandboxError(electron);
    }
    if (sandboxError) fail(sandboxError);
  }
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    args.push("--ozone-platform=headless", "--screen-info={8192x8192}");
  }
  const result = spawnSync(electron, args, {
    cwd: browserDirectory(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `browser utility exited with status ${result.status}`);
  }
  const line = result.stdout.trim().split(/\r?\n/).at(-1);
  if (!line) throw new Error("browser utility returned no result");
  return line;
}

function clientLaunchCommand(argv: string[]): string[] {
  const runner = DIST_ROOT
    ? [path.join(DIST_ROOT, "bin", "terminal-browser")]
    : [process.execPath, path.resolve(__dirname, "main.js")];
  return [...runner, "open", ...argv];
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
  sessions?: number;
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

async function daemonPid(): Promise<number | null> {
  for (const record of await instances()) {
    try {
      process.kill(record.pid, 0);
      return record.pid;
    } catch {}
  }
  return null;
}

async function gone(pid: number, within: number): Promise<boolean> {
  const deadline = Date.now() + within;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await sleep(100);
  }
  return false;
}

async function shutdownDaemon(): Promise<number> {
  let socket: net.Socket | null = null;
  try {
    socket = await connectDaemon();
  } catch {}
  const pid = await daemonPid();
  if (!socket) {
    if (pid === null) {
      process.stdout.write("no daemon running\n");
      return 0;
    }
    return kill(pid, "it was not listening");
  }
  const answer = await new Promise<DaemonReply | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 2500);
    const settle = (value: DaemonReply | null) => {
      clearTimeout(timer);
      resolve(value);
    };
    nextReply(socket!, settle);
    socket!.once("close", () => settle({ ok: true }));
    socket!.write('{"cmd":"shutdown"}\n');
  });
  socket.destroy();
  if (answer === null) {
    if (pid === null) fail("the daemon did not answer and no browser names its process");
    return kill(pid, "it did not answer");
  }
  const browsers = answer.sessions ?? 0;
  process.stdout.write(
    browsers === 0 ? "daemon stopped\n" : `daemon stopped, with ${browsers} open\n`,
  );
  return 0;
}

async function kill(pid: number, why: string): Promise<number> {
  process.kill(pid, "SIGTERM");
  if (!(await gone(pid, 2000))) process.kill(pid, "SIGKILL");
  process.stdout.write(`daemon stopped, killed ${pid} because ${why}\n`);
  return 0;
}

async function attachHere(argv: string[], onStarted?: () => void): Promise<never> {
  const tty = ownTtyPath();
  if (!tty) throw new Error("not running on a tty");
  const { socket, reply } = await openSession(argv, tty);
  if (reply.ok === false || !reply.session) {
    socket.destroy();
    throw new Error(reply.error ?? "daemon refused the session");
  }
  onStarted?.();
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

async function openHere(argv: string[], onStarted?: () => void): Promise<never> {
  return attachHere(argv, onStarted).catch((error) =>
    fail(`could not start the browser: ${String(error)}`),
  );
}

async function launchInSplit(
  terminal: Terminal,
  direction: Direction,
  argv: string[],
  size?: number | null,
): Promise<InstanceRecord> {
  const from = await terminal.getCurrentPane?.({ tty: ownTtyPath() ?? callerTty().path, cwd: process.cwd() });
  if (!from) fail(`could not work out which ${terminal.name} pane you are in`);
  const before = new Set((await instances()).map(recordKey));
  await terminal.split!({
    from,
    direction,
    command: clientLaunchCommand(argv),
    size: size ?? null,
    tty: ownTtyPath() ?? callerTty().path,
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const fresh = (await instances()).find((record) => !before.has(recordKey(record)));
    if (fresh) {
      return fresh;
    }
    await sleep(250);
  }
  fail("browser did not register within 20s (is the split open?)");
}

let asked: Promise<TerminalCheck> | null = null;

function currentTerminal(): Promise<TerminalCheck> {
  asked ??= checkTerminal(detect());
  return asked;
}

async function newTabCommand(url: string | undefined, key: string | undefined): Promise<number> {
  const check = await currentTerminal();
  const found = await browsers(check.terminal);
  const here = key
    ? found.filter((browser) => recordKey(browser) === key)
    : found.filter((browser) => browser.inCurrentTab);
  const list = (browsers: Browser[]) => browsers.map((browser) => `  ${describe(browser)}`).join("\n");
  if (key && here.length === 0) fail(`no browser ${key}. Running:\n${list(found)}`);
  if (here.length > 1) {
    fail(`${here.length} browsers in this tab, so say which with --browser:\n${list(here)}`);
  }
  const target = here[0];
  if (target) {
    const where = url ? { cmd: "open-tab", url, cwd: process.cwd() } : { cmd: "open-tab" };
    print(await control(target.socket, where));
    return 0;
  }
  await requireGraphics(check);
  const argv = url ? [url] : [];
  applyConfiguredDefaultProfile(argv);
  if (interactiveTty()) return openHere(argv);
  if (!canSplit(check.terminal)) fail(cannotOpenPanes(check.terminal));
  const split = url && fs.existsSync(url) ? [path.resolve(url)] : argv;
  split.push("--split-dir=right");
  const tty = ownTtyPath() ?? callerTty().path;
  if (tty) split.push(`--parent-tty=${tty}`);
  print(await launchInSplit(check.terminal!, "right", split, null));
  return 0;
}

async function requireGraphics(check: TerminalCheck) {
  if (check.graphics !== "unsupported") return;
  process.stderr.write(unsupportedGraphicsMessage(process.stderr.isTTY === true));
  process.exit(1);
}

function requirePaneAccess(): void {
  const refusal = sandboxRefusal();
  if (refusal) fail(refusal);
}

async function openCommand(request: OpenRequest) {
  requirePaneAccess();
  const args = [...(request.target ? [request.target] : []), ...request.browserArgs];
  const split = request.split ?? null;
  const size = request.size ?? null;
  const profile = request.profile;
  let profileNameToSave: string | null = null;
  if (profile) {
    if (args.some((arg) => arg.startsWith("--partition="))) {
      fail("--profile and --partition cannot be used together");
    }
    if (profile !== "default") {
      const name = namedProfileName(profile);
      if (!findProfile(name)) profileNameToSave = name;
      args.push(`--partition=${name}`);
    }
  } else {
    applyConfiguredDefaultProfile(args);
  }
  if (size !== null && !split) fail("--size only applies to a split (--split <direction>)");
  await requireGraphics(await currentTerminal());
  const saveCreatedProfile = () => {
    if (profileNameToSave && !findProfile(profileNameToSave)) {
      saveProfile({ createdAt: new Date().toISOString(), name: profileNameToSave });
    }
  };
  if (!split && interactiveTty()) {
    return openHere(args, saveCreatedProfile);
  }
  const terminal = (await currentTerminal()).terminal;
  const direction = split ?? "right";
  if (!canSplit(terminal)) fail(cannotOpenPanes(terminal));
  const url = args.find((arg) => !arg.startsWith("-"));
  const own = ownTtyPath();
  const caller = own ? null : callerTty();
  if (caller?.denied) {
    const refusal = deniedRefusal();
    if (refusal) fail(refusal);
  }
  const tty = own ?? caller?.path ?? null;
  const argv = args.map((arg) => (arg === url && fs.existsSync(arg) ? path.resolve(arg) : arg));
  argv.push(`--split-dir=${direction}`);
  if (tty) argv.push(`--parent-tty=${tty}`);
  const launched = await launchInSplit(terminal!, direction, argv, size);
  saveCreatedProfile();
  print(launched);
}

function applyConfiguredDefaultProfile(args: string[]): void {
  if (args.some((arg) => arg.startsWith("--partition="))) return;
  const name = profileSettings().defaultProfile;
  if (!name) return;
  if (!findProfile(name)) {
    fail(`default profile ${name} is missing; reset it with terminal-browser profile default --reset`);
  }
  args.push(`--partition=${name}`);
}

async function main(): Promise<number> {
  const actions: CliActions = {
    action: async (options) => {
      requirePaneAccess();
      return actionCommand((await currentTerminal()).terminal, options);
    },
    keybindings: (request) => keybindingsCommand(request, detect()),
    ls: async (all, json) => {
      requirePaneAccess();
      return lsCommand((await currentTerminal()).terminal, all, json);
    },
    newTab: async ({ browserKey, target }) => {
      requirePaneAccess();
      return newTabCommand(target, browserKey);
    },
    open: openCommand,
    profile: (request) => profileCommand(request, {
      importCookies: runCookieImport,
      removePartition: runProfileRemoval,
    }),
    setup: () => {
      const sandbox = apparmorSetup(electronBinary());
      const editors = setupCommand();
      return editors !== 0 ? editors : sandbox;
    },
    shutdown: shutdownDaemon,
    upgrade: upgradeCommand,
  };
  return runCli(process.argv.slice(2), actions, {
    version: installedVersion() ?? "dev",
  });
}

void main()
  .then((code) => {
    if (code) process.exit(code);
  })
  .catch((error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
  });
