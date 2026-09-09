#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import {
  DAEMON_SOCKET,
  LOGS_DIR,
  appId,
  ensureDataDir,
  instanceKey,
  listApps,
  registerApp,
  unregisterApp,
} from "pixel-store";
import type { OpenSpec } from "pixel-store";
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
import { ensureSetup, linkSkills, markSetupDone } from "./setup";
import { commandHelp, helpTopics, rootHelp } from "./help";
import { browsers, describe, recordKey } from "./instances";
import type { Browser } from "./instances";
import { findHosts, openInHost } from "./interop";
import { lsCommand } from "./ls";
import { instances } from "./registry";
import { apparmorSetup, deniedRefusal, linuxSandboxError, sandboxRefusal } from "./sandbox";
import { openSshTunnel, startBundle, validateBundleDir, validateSshTarget } from "./ssh";
import type { RemoteBundle } from "./ssh";
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
  const main = path.join(browserDir, "dist", "main.js");
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
  const payload = {
    cmd: "open",
    tty,
    argv,
    env: process.env,
    cwd: process.cwd(),
  };
  const ask = (socket: net.Socket, build: string | null) =>
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
      socket.write(`${JSON.stringify(build ? { ...payload, build } : payload)}\n`);
    });
  let socket = await daemonSocket();
  let reply = await ask(socket, browserBuildStamp());
  if (reply.ok === false && reply.error === "stale") {
    socket.destroy();
    await sleep(700);
    socket = await daemonSocket();
    reply = await ask(socket, browserBuildStamp());
  }
  if (reply.ok === false && reply.error === "stale") {
    socket.destroy();
    socket = await daemonSocket();
    reply = await ask(socket, null);
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

async function attachHere(argv: string[]): Promise<never> {
  const tty = ownTtyPath();
  if (!tty) throw new Error("not running on a tty");
  const { socket, reply } = await openSession(argv, tty);
  if (reply.ok === false || !reply.session) {
    socket.destroy();
    throw new Error(reply.error ?? "daemon refused the session");
  }
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
  process.on("SIGHUP", requestClose);
  return new Promise<never>(() => {});
}

async function openHere(argv: string[]): Promise<never> {
  await sshSetup(argv).catch((error) =>
    fail(error instanceof Error ? error.message : String(error)),
  );
  return attachHere(argv).catch((error) => fail(`could not start the browser: ${String(error)}`));
}

function flagEq(argv: string[], flag: string): string | undefined {
  return argv.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

async function sshSetup(argv: string[]): Promise<void> {
  const target = flagEq(argv, "--ssh");
  if (!target) return;
  const status = (line: string) => process.stdout.write(`ssh: ${line}\n`);
  const interrupt = () => process.exit(130);
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, interrupt);
  let bundle: RemoteBundle | null = null;
  const tunnel = await openSshTunnel(target, status);
  process.on("exit", () => {
    try {
      bundle?.stop();
    } catch {}
    tunnel.stop();
  });
  argv.push(`--socks-port=${tunnel.socksPort}`);
  const bundleDir = flagEq(argv, "--ssh-bundle");
  if (bundleDir) {
    const remoteBase = flagEq(argv, "--ssh-bundle-dir");
    bundle = await startBundle(tunnel, bundleDir, status, remoteBase || undefined);
    if (!argv.some((arg) => !arg.startsWith("-"))) argv.unshift(bundle.url);
  }
  for (const signal of signals) process.removeListener(signal, interrupt);
}

const DIRECTIONS: Direction[] = ["right", "left", "down", "up"];

function isDirection(value: string): value is Direction {
  return (DIRECTIONS as string[]).includes(value);
}

function takeSplitFlag(args: string[]): Direction | null {
  const raw = takeFlag(args, "--split");
  if (raw === undefined) return null;
  if (!isDirection(raw)) fail(`invalid --split ${raw} (right, left, down, up)`);
  return raw;
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
  // ssh auth prompts and bundle installs run inside the new pane first
  const patience = argv.some((arg) => arg.startsWith("--ssh=")) ? 600_000 : 20_000;
  const deadline = Date.now() + patience;
  while (Date.now() < deadline) {
    const fresh = (await instances()).find((record) => !before.has(recordKey(record)));
    if (fresh) {
      return fresh;
    }
    await sleep(250);
  }
  fail(`browser did not register within ${Math.round(patience / 1000)}s (is the split open?)`);
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
  if (!key && !mergeDisabled() && (await tryAdopt(url ? [url] : []))) return 0;
  await requireGraphics(check);
  const argv = url ? [url] : [];
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

const BROWSER_FLAGS = [
  "--app-mode",
  "--no-toolbar",
  "--no-shortcuts",
  "--no-context-menu",
  "--no-overlays",
  "--no-frame",
  "--open-tabs-in-popup-stack",
  "--allow-clipboard-read",
  "--no-adblock",
  "--partition=",
  "--ssh=",
  "--ssh-bundle=",
  "--ssh-bundle-dir=",
  "--preload=",
  "--main-script=",
  "--app-name=",
  "--app-id=",
  "--palette-key=",
  "--find-key=",
  "--devtools-key=",
  "--console-key=",
  "--split-dir=",
  "--parent-tty=",
];

function rejectUnknownFlags(args: string[]) {
  for (const arg of args) {
    if (!arg.startsWith("-")) continue;
    const known = BROWSER_FLAGS.some((flag) =>
      flag.endsWith("=") ? arg.startsWith(flag) : arg === flag,
    );
    if (!known) fail(`unknown option ${arg.split("=")[0]} (terminal-browser open --help)`);
  }
}

function takeSshFlags(args: string[]): void {
  const ssh = takeFlag(args, "--ssh");
  if (ssh !== undefined) args.push(`--ssh=${ssh}`);
  const bundle = takeFlag(args, "--ssh-bundle");
  if (bundle !== undefined) args.push(`--ssh-bundle=${bundle}`);
  const bundleDir = takeFlag(args, "--ssh-bundle-dir");
  if (bundleDir !== undefined) args.push(`--ssh-bundle-dir=${bundleDir}`);
  const at = args.findIndex((arg) => arg.startsWith("--ssh-bundle="));
  if (at >= 0) {
    args[at] = `--ssh-bundle=${path.resolve(args[at].slice("--ssh-bundle=".length))}`;
  }
  const target = args.find((arg) => arg.startsWith("--ssh="))?.slice("--ssh=".length);
  if (at >= 0 && !target) fail("--ssh-bundle needs --ssh");
  if (args.some((arg) => arg.startsWith("--ssh-bundle-dir=")) && at < 0) {
    fail("--ssh-bundle-dir needs --ssh-bundle");
  }
  try {
    if (target) validateSshTarget(target);
    if (at >= 0) validateBundleDir(args[at].slice("--ssh-bundle=".length));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function requirePaneAccess(): void {
  const refusal = sandboxRefusal();
  if (refusal) fail(refusal);
}

function mergeDisabled(): boolean {
  return process.env.TERMINAL_BROWSER_NO_MERGE === "1";
}

async function tryAdopt(args: string[]): Promise<boolean> {
  const terminal = (await currentTerminal()).terminal;
  const hosts = await findHosts(terminal).catch(() => []);
  if (hosts.length === 0) return false;
  const url = args.find((arg) => !arg.startsWith("-"));
  const resolved = url && fs.existsSync(url) ? path.resolve(url) : url;
  if (!args.includes("--app-mode")) {
    for (const host of hosts) {
      try {
        const opened = await openInHost(host.socket, { url: resolved });
        print({ adopted: instanceKey(host), socket: host.socket, tab: opened.tab });
        return true;
      } catch {}
    }
    return false;
  }
  if (!resolved) return false;
  const name = flagEq(args, "--app-name");
  const idFlag = flagEq(args, "--app-id");
  const app: NonNullable<OpenSpec["app"]> = { id: appId(idFlag ?? name ?? "app") };
  if (name !== undefined) app.name = name;
  const partition = flagEq(args, "--partition");
  if (partition) app.partition = partition;
  const preload = flagEq(args, "--preload");
  if (preload) app.preload = path.resolve(preload);
  const mainScript = flagEq(args, "--main-script");
  if (mainScript) app.mainScript = path.resolve(mainScript);
  const spec: OpenSpec = { url: resolved, app };
  for (const host of hosts) {
    try {
      const opened = await openInHost(host.socket, spec);
      print({ adopted: instanceKey(host), socket: host.socket, tab: opened.tab });
      return true;
    } catch {}
  }
  return false;
}

async function openCommand(args: string[]) {
  requirePaneAccess();
  const split = takeSplitFlag(args);
  const size = takeSizeFlag(args);
  const noMerge = takeBoolFlag(args, "--no-merge") || mergeDisabled();
  if (size !== null && !split) fail("--size only applies to a split (--split <direction>)");
  takeSshFlags(args);
  rejectUnknownFlags(args);
  const positionals = args.filter((arg) => !arg.startsWith("-"));
  if (positionals.length > 1) {
    fail(`unexpected ${positionals[1]} (one url; --split <direction> opens a new pane)`);
  }
  const targeted = Boolean(process.env.TERMINAL_BROWSER_INTEROP_TARGET);
  const wouldSplit = split !== null || !interactiveTty();
  if (!noMerge && (wouldSplit || targeted) && !args.some((arg) => arg.startsWith("--ssh="))) {
    if (await tryAdopt(args)) return;
  }
  await requireGraphics(await currentTerminal());
  if (!split && interactiveTty()) {
    return openHere(args);
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
  print(await launchInSplit(terminal!, direction, argv, size));
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

function registerAppCommand(args: string[]): number {
  const idFlag = takeFlag(args, "--id");
  const name = takeFlag(args, "--name");
  const bin = takeFlag(args, "--bin");
  const argsFlag = takeFlag(args, "--args");
  if (!name) fail("register-app needs --name");
  if (!bin) fail("register-app needs --bin");
  const binPath = path.resolve(bin);
  if (!fs.existsSync(binPath)) fail(`no such file ${binPath}`);
  const id = appId(idFlag ?? name);
  registerApp({
    id,
    name,
    bin: binPath,
    args: argsFlag ? argsFlag.split(/\s+/).filter(Boolean) : [],
  });
  process.stdout.write(`registered ${name} (${id})\n`);
  return 0;
}

function unregisterAppCommand(args: string[]): number {
  const id = args.find((arg) => !arg.startsWith("-"));
  if (!id) fail("unregister-app needs an app id (terminal-browser apps)");
  if (!unregisterApp(appId(id))) fail(`no registered app ${id}`);
  process.stdout.write(`unregistered ${id}\n`);
  return 0;
}

function appsCommand(args: string[]): number {
  const json = takeBoolFlag(args, "--json");
  const apps = listApps();
  if (json) {
    print(apps);
    return 0;
  }
  if (apps.length === 0) {
    process.stdout.write("no apps registered\n");
    return 0;
  }
  const rows = apps.map((app) => [app.id, app.name, app.bin]);
  const header = ["id", "name", "bin"];
  const widths = header.map((label, col) =>
    Math.max(label.length, ...rows.map((row) => row[col].length)),
  );
  for (const row of [header, ...rows]) {
    const line = row.map((cell, col) => cell.padEnd(widths[col])).join("  ");
    process.stdout.write(`${line.trimEnd()}\n`);
  }
  return 0;
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
  if (command === "--help" || command === "-h") {
    process.stdout.write(rootHelp());
    return 0;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(`terminal-browser ${installedVersion() ?? "dev"}\n`);
    return 0;
  }
  if (command === "help") return helpCommand(args[0]);
  if (asksForHelp(args)) {
    process.stdout.write(commandHelp(command) ?? rootHelp());
    return 0;
  }
  if (command !== "setup") ensureSetup();
  if (command === "open") {
    await openCommand(args);
    return 0;
  }
  if (command === "ls") {
    requirePaneAccess();
    const all = takeBoolFlag(args, "--all");
    const json = takeBoolFlag(args, "--json");
    await lsCommand((await currentTerminal()).terminal, all, json);
    return 0;
  }
  if (command === "setup") {
    const sandbox = apparmorSetup(electronBinary());
    linkSkills();
    const editors = setupCommand();
    markSetupDone();
    return editors !== 0 ? editors : sandbox;
  }
  if (command === "upgrade") return upgradeCommand();
  if (command === "shutdown") return shutdownDaemon();
  if (command === "register-app") return registerAppCommand(args);
  if (command === "unregister-app") return unregisterAppCommand(args);
  if (command === "apps") return appsCommand(args);
  if (command === "new-tab") {
    requirePaneAccess();
    const key = takeFlag(args, "--browser");
    return newTabCommand(args.find((arg) => !arg.startsWith("-")), key);
  }
  if (command === "action") {
    requirePaneAccess();
    const { own, passthrough } = splitPassthrough(args);
    const options = {
      browserKey: takeFlag(own, "--browser"),
      tabId: takeTabFlag(own),
      targetId: takeFlag(own, "--target"),
      follow: takeBoolFlag(own, "--follow"),
      done: false,
      passthrough,
    };
    if (own[0] === "done") {
      own.shift();
      options.done = true;
      if (passthrough.length > 0) fail("[PLACEHOLDER COPY]");
    }
    if (own.length > 0) fail(`unexpected ${own[0]} — put agent-browser arguments after --`);
    return actionCommand((await currentTerminal()).terminal, options);
  }
  const rest = process.argv.slice(2);
  if (asksForHelp(rest)) {
    process.stdout.write(commandHelp("open") ?? rootHelp());
    return 0;
  }
  await openCommand(rest);
  return 0;
}

void main()
  .then((code) => {
    if (code) process.exit(code);
  })
  .catch((error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
  });
