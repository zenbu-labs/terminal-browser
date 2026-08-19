#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";

import { DAEMON_SOCKET, LOGS_DIR, ensureDataDir, readSocketControlSecret } from "pixel-store";
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
import { commandHelp, helpTopics, rootHelp } from "./help";
import { browsers, describe, recordKey } from "./instances";
import type { Browser } from "./instances";
import { lsCommand } from "./ls";
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

function takeFlag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined) fail(`${name} requires a value`);
  args.splice(at, 2);
  return value;
}

function takeFlags(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let value = takeFlag(args, name); value !== undefined; value = takeFlag(args, name)) {
    values.push(value);
  }
  return values;
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

function dialDaemon(): Promise<net.Socket> {
  const { promise, resolve, reject } = Promise.withResolvers<net.Socket>();
  const socket = net.connect(DAEMON_SOCKET);
  socket.once("connect", () => resolve(socket));
  socket.once("error", reject);
  return promise;
}

/** The daemon dispatches nothing until this line proves the secret it holds too. */
function handshake(socket: net.Socket): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const secret = readSocketControlSecret();
  if (!secret) {
    reject(new Error("no browser control secret yet; start the browser first"));
    return promise;
  }
  function finish(settle: () => void) {
    clearTimeout(timer);
    socket.off("data", onData);
    socket.off("close", onClose);
    settle();
  }
  let buffer = "";
  const timer = setTimeout(
    () => finish(() => reject(new Error("the daemon did not answer the handshake"))),
    5000,
  );
  const onData = (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    const rest = buffer.slice(newline + 1);
    finish(() => {
      // Nothing else is sent before the first command, but put back whatever did arrive
      // so the caller's own reader still sees it.
      if (rest) socket.unshift(Buffer.from(rest, "utf8"));
      let reply: DaemonReply;
      try {
        reply = JSON.parse(line) as DaemonReply;
      } catch {
        reject(new Error("the daemon answered the handshake with something other than json"));
        return;
      }
      if (reply.ok) resolve();
      else reject(new Error(reply.error ?? "the daemon refused the handshake"));
    });
  };
  const onClose = () => finish(() => reject(new Error("daemon closed the connection")));
  socket.on("data", onData);
  socket.once("close", onClose);
  socket.write(`${JSON.stringify({ cmd: "auth", secret })}\n`);
  return promise;
}

function spawnDaemon() {
  const { command, cwd } = browserLaunchCommand(["--daemon"]);
  const child = spawn(command[0], command.slice(1), { cwd, detached: true, stdio: "ignore" });
  child.unref();
}

async function daemonSocket(): Promise<net.Socket> {
  let socket = await dialDaemon().catch(() => null);
  if (!socket) {
    spawnDaemon();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      socket = await dialDaemon().catch(() => null);
      if (socket) break;
      await sleep(200);
    }
    if (!socket) throw new Error("daemon did not start");
  }
  // A refused handshake is not a missing daemon: respawning cannot fix a wrong secret.
  try {
    await handshake(socket);
  } catch (error) {
    socket.destroy();
    throw error;
  }
  return socket;
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
    socket = await dialDaemon();
    await handshake(socket);
  } catch {
    socket?.destroy();
    socket = null;
  }
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
  return new Promise<never>(() => {});
}

async function openHere(argv: string[]): Promise<never> {
  return attachHere(argv).catch((error) => fail(`could not start the browser: ${String(error)}`));
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

interface ImportCookiesOptions {
  browserKey?: string;
  profile?: string;
  domain?: string;
  from?: string;
  confirmed: boolean;
  json: boolean;
  leftover: string[];
}

interface CookieSourceRow {
  slug: string;
  displayName: string;
  profiles: { directory: string; name: string }[];
}

interface CookieImportReport {
  browser: string;
  profile: string;
  profileName: string;
  domains: string[];
  warnings: string[];
  imported: number;
  undecryptable: number;
  rejected: number;
}

function renderSources(sources: CookieSourceRow[]): string {
  return sources
    .map((source) => {
      const profiles = source.profiles
        .map((profile) =>
          profile.name === profile.directory ? profile.directory : `${profile.name} (${profile.directory})`,
        )
        .join(", ");
      return `  ${source.displayName}  ${profiles}\n`;
    })
    .join("");
}

async function confirmImport(
  sources: CookieSourceRow[],
  target: string,
  options: ImportCookiesOptions,
): Promise<boolean> {
  if (sources.length > 0) {
    process.stderr.write(`Browsers on this machine with cookies to copy:\n${renderSources(sources)}\n`);
  }
  const scope = options.domain ? `cookies for ${options.domain} and its subdomains` : "login cookies";
  const profile = options.profile ? ` (${options.profile})` : "";
  // The daemon reads Chrome when it is installed, otherwise the first browser it found: name that one.
  const picked = sources.find((source) => source.slug === "google-chrome") ?? sources[0];
  const named = options.from ?? picked?.displayName;
  const origin = named ? `out of ${named}${profile}` : `out of whichever browser it finds${profile}`;
  process.stderr.write(
    `Copying ${scope} ${origin} into ${target}.\n` +
      "These are your real sessions: afterwards anything that can reach that browser is signed in as you.\n",
  );
  if (!options.from && sources.length > 1) {
    process.stderr.write("Pass --from to copy out of one of the others instead.\n");
  }
  const ask = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((resolve) => {
    ask.question("copy them? [y/N] ", resolve);
    ask.on("close", () => resolve("n"));
  });
  ask.close();
  return /^(y|yes)$/i.test(answer.trim());
}

function renderImport(report: CookieImportReport): string {
  const profile = report.profileName === report.profile ? report.profile : `${report.profileName}, ${report.profile}`;
  const lines = [`Imported ${report.imported} cookies from ${report.browser} (${profile}).`];
  if (report.domains.length > 0) lines.push(`Limited to ${report.domains.join(", ")} and subdomains.`);
  if (report.warnings.length > 0) {
    lines.push("", "Warnings:", ...report.warnings.map((warning) => `- ${warning}`));
  }
  return `${lines.join("\n")}\n`;
}

async function importCookiesCommand(options: ImportCookiesOptions): Promise<number> {
  if (options.leftover.length > 0) fail(`unexpected ${options.leftover[0]}`);
  const check = await currentTerminal();
  const found = await browsers(check.terminal);
  const here = options.browserKey
    ? found.filter((browser) => recordKey(browser) === options.browserKey)
    : found.filter((browser) => browser.inCurrentTab);
  const list = (list: Browser[]) => list.map((browser) => `  ${describe(browser)}`).join("\n");
  if (found.length === 0) {
    fail("no terminal browser is running — open one first, then import into it");
  }
  if (here.length === 0) {
    fail(`no browser in this tab. Running:\n${list(found)}\n\nPick one with --browser`);
  }
  if (here.length > 1) {
    fail(`${here.length} browsers in this tab, so say which with --browser:\n${list(here)}`);
  }
  const target = here[0];
  if (!options.confirmed && process.stdin.isTTY) {
    if (!process.stderr.isTTY) {
      fail("stderr is redirected, so the confirmation cannot be shown — re-run with -y to copy without asking");
    }
    const sources = (await control(target.socket, { cmd: "cookie-sources" }).catch((error: unknown) => {
      process.stderr.write(
        `terminal-browser: could not list source browsers: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return [];
    })) as CookieSourceRow[];
    if (!(await confirmImport(sources, describe(target), options))) {
      process.stderr.write("terminal-browser: cancelled, nothing was copied\n");
      return 1;
    }
  }
  const report = (await control(
    target.socket,
    { cmd: "import-cookies", from: options.from, profile: options.profile, domain: options.domain },
    120_000,
  )) as CookieImportReport;
  if (options.json) {
    print(report);
    return 0;
  }
  process.stdout.write(renderImport(report));
  return 0;
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
  "--partition=",
  "--preload=",
  "--main-script=",
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

function requirePaneAccess(): void {
  const refusal = sandboxRefusal();
  if (refusal) fail(refusal);
}

async function openCommand(args: string[]) {
  requirePaneAccess();
  const split = takeSplitFlag(args);
  const size = takeSizeFlag(args);
  if (size !== null && !split) fail("--size only applies to a split (--split <direction>)");
  rejectUnknownFlags(args);
  const positionals = args.filter((arg) => !arg.startsWith("-"));
  if (positionals.length > 1) {
    fail(`unexpected ${positionals[1]} (one url; --split <direction> opens a new pane)`);
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
    const editors = setupCommand();
    return editors !== 0 ? editors : sandbox;
  }
  if (command === "upgrade") return upgradeCommand();
  if (command === "shutdown") return shutdownDaemon();
  if (command === "new-tab") {
    requirePaneAccess();
    const key = takeFlag(args, "--browser");
    return newTabCommand(args.find((arg) => !arg.startsWith("-")), key);
  }
  if (command === "import-cookies") {
    requirePaneAccess();
    const browserKey = takeFlag(args, "--browser");
    const profile = takeFlag(args, "--profile");
    // A repeated --domain is as natural as one comma-separated list, so accept both.
    const domains = takeFlags(args, "--domain");
    const from = takeFlag(args, "--from");
    const confirmed = takeBoolFlag(args, "-y") || takeBoolFlag(args, "--yes");
    const json = takeBoolFlag(args, "--json");
    return importCookiesCommand({
      browserKey,
      profile,
      domain: domains.length > 0 ? domains.join(",") : undefined,
      from,
      confirmed,
      json,
      leftover: args,
    });
  }
  if (command === "action") {
    requirePaneAccess();
    const { own, passthrough } = splitPassthrough(args);
    const options = {
      browserKey: takeFlag(own, "--browser"),
      tabId: takeTabFlag(own),
      targetId: takeFlag(own, "--target"),
      follow: takeBoolFlag(own, "--follow"),
      passthrough,
    };
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
