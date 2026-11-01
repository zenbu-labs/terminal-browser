import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { AGENT_SOCKETS_DIR, CDP_SOCKET, ensurePrivateDir } from "shared";
import type { Terminal } from "@zenbu-labs/pixel/terminal";

import { control } from "./control";
import { browsers, describe, recordKey, targets } from "./instances";
import type { Browser, TabTarget } from "./instances";
import { err, outJson, runRelayed } from "./output";

const DIST_ROOT = process.env.TERMINAL_BROWSER_DIST_ROOT ?? null;

interface AgentTab {
  tabId: string;
  url: string;
  title: string;
  active: boolean;
}

interface Selection {
  browser: Browser;
  tab: TabTarget;
}

export interface ActionOptions {
  browserKey?: string;
  tabId?: number;
  targetId?: string;
  follow: boolean;
  done: boolean;
  passthrough: string[];
}

function repoScript(): string {
  return path.resolve(__dirname, "..", "..", "scripts", "agent-browser.sh");
}

const PRIVATE_CDP_BUILD = "terminal-browser private-cdp build";

// A stock agent-browser opens its own TCP ports and runs any command, so only
// the build patched for terminal-browser is used.
function requirePatchedBuild(binary: string): string {
  const version = spawnSync(binary, ["--version"], { encoding: "utf8", env: childEnv(), timeout: 10_000 });
  if (!version.stdout?.includes(PRIVATE_CDP_BUILD)) {
    // fixme: placeholder copy
    throw new Error(`${binary} is not the agent-browser build terminal-browser ships, so it is not used`);
  }
  return binary;
}

export function agentBrowserPath(): string {
  const binary = findAgentBrowser(process.env, DIST_ROOT);
  // The release's own copy came with it and is never asked to vouch for itself.
  return DIST_ROOT ? binary : requirePatchedBuild(binary);
}

// A release only ever runs the agent-browser it shipped with: a --version
// marker can be faked by any wrapper, so an override isn't trusted there.
export function findAgentBrowser(env: NodeJS.ProcessEnv, distRoot: string | null): string {
  const override = env.TERMINAL_BROWSER_AGENT;
  if (override && distRoot) {
    // fixme: placeholder copy
    throw new Error("TERMINAL_BROWSER_AGENT is not used by installed terminal-browser releases");
  }
  if (override) {
    if (!fs.existsSync(override)) {
      throw new Error(`TERMINAL_BROWSER_AGENT points at a missing file: ${override}`);
    }
    return override;
  }
  if (distRoot) {
    const shipped = path.join(distRoot, "agent-browser", "bin", "agent-browser");
    if (fs.existsSync(shipped)) return shipped;
    throw new Error(`missing ${shipped} — the release is incomplete`);
  }
  const script = repoScript();
  if (!fs.existsSync(script)) throw new Error(`missing ${script}`);
  return execFileSync(script, ["--path"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

function sessionName(browser: Browser): string {
  return `terminal-browser-${recordKey(browser)}`;
}

function cdpSocket(): string {
  return path.join(ensurePrivateDir(path.dirname(CDP_SOCKET)), path.basename(CDP_SOCKET));
}

function cdpEndpoint(): string {
  return `ws+unix:${cdpSocket()}`;
}

// agent-browser also reads ./agent-browser.json, ~/.agent-browser/config.json
// and AGENT_BROWSER_* variables, any of which could point it at another browser.
function childEnv(): NodeJS.ProcessEnv {
  const socketDir = ensurePrivateDir(AGENT_SOCKETS_DIR);
  const config = path.join(socketDir, "config.json");
  fs.writeFileSync(config, "{}", { mode: 0o600 });
  fs.chmodSync(config, 0o600);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("AGENT_BROWSER_") && key !== "NODE_OPTIONS"),
  );
  return { ...env, AGENT_BROWSER_SOCKET_DIR: socketDir, AGENT_BROWSER_CONFIG: config };
}

function agentArgs(session: string, args: string[]): string[] {
  return ["--session", session, "--cdp", cdpEndpoint(), ...args];
}

// The command goes to agent-browser through an already-unlinked 0600 file on
// fd 3, never argv, so what it carries (passwords in `fill`) isn't in ps.
function withArgsOnFd<T>(args: string[], run: (fd: number) => T): T {
  const file = path.join(ensurePrivateDir(AGENT_SOCKETS_DIR), `args-${crypto.randomBytes(12).toString("hex")}`);
  fs.writeFileSync(file, JSON.stringify(args), { mode: 0o600, flag: "wx" });
  const fd = fs.openSync(file, "r");
  fs.unlinkSync(file);
  let result: T;
  try {
    result = run(fd);
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
  if (result instanceof Promise) return result.finally(() => fs.closeSync(fd)) as T;
  fs.closeSync(fd);
  return result;
}

function agentEnv(): NodeJS.ProcessEnv {
  return { ...childEnv(), AGENT_BROWSER_ARGS_FD: "3" };
}

function runAgent(binary: string, session: string, args: string[]): { status: number; stdout: string } {
  const result = withArgsOnFd(agentArgs(session, args), (fd) =>
    spawnSync(binary, [], { encoding: "utf8", env: agentEnv(), stdio: ["ignore", "pipe", "pipe", fd] }),
  );
  if (result.error) throw result.error;
  if (result.stderr) err(result.stderr);
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

function stopAgentDaemon(session: string) {
  const pidFile = path.join(ensurePrivateDir(AGENT_SOCKETS_DIR), `${session}.pid`);
  let pid: number;
  try {
    pid = Number(fs.readFileSync(pidFile, "utf8"));
  } catch {
    return;
  }
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(pid);
  } catch {}
  for (let i = 0; i < 20; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    spawnSync("sleep", ["0.1"]);
  }
}

function parseTabs(stdout: string): AgentTab[] {
  const parsed = JSON.parse(stdout) as { data?: { tabs?: unknown[] }; tabs?: unknown[] };
  const rows = (parsed.data?.tabs ?? parsed.tabs ?? []) as Record<string, unknown>[];
  return rows.map((row) => ({
    tabId: String(row.tabId ?? ""),
    url: String(row.url ?? ""),
    title: String(row.title ?? ""),
    active: row.active === true,
  }));
}

function evalResult(stdout: string): unknown {
  const parsed = JSON.parse(stdout) as { data?: { result?: unknown } };
  return parsed.data?.result;
}

function agentTabs(binary: string, browser: Browser): AgentTab[] {
  const session = sessionName(browser);
  const listing = runAgent(binary, session, ["tab", "list", "--json"]);
  if (listing.status === 0) {
    try {
      return parseTabs(listing.stdout);
    } catch {}
  }
  // An agent-browser daemon left from an earlier socket path refuses ours; start a fresh one.
  stopAgentDaemon(session);
  const retry = runAgent(binary, session, ["tab", "list", "--json"]);
  if (retry.status !== 0) {
    // fixme: placeholder copy
    throw new Error(`could not connect agent-browser to terminal browser ${recordKey(browser)} over ${CDP_SOCKET}`);
  }
  return parseTabs(retry.stdout);
}

function matchTab(
  binary: string,
  session: string,
  agentView: AgentTab[],
  tab: TabTarget,
): AgentTab {
  // Extension background pages and popups are page targets too, but never one of our tabs.
  if (!tab.url.startsWith("chrome-extension://")) {
    agentView = agentView.filter((entry) => !entry.url.startsWith("chrome-extension://"));
  }
  if (agentView.length === 0) throw new Error("agent-browser sees no tabs on this browser");
  const sameUrl = agentView.filter((entry) => entry.url === tab.url);
  if (sameUrl.length === 1) return sameUrl[0];
  const candidates = sameUrl.length > 0 ? sameUrl : agentView;
  if (candidates.length === 1) return candidates[0];
  if (typeof tab.timeOrigin !== "number") {
    throw new Error(
      `cannot tell which of ${candidates.length} tabs on ${tab.url} is terminal browser tab ${tab.id}`,
    );
  }
  for (const candidate of candidates) {
    runAgent(binary, session, ["tab", candidate.tabId]);
    const probe = runAgent(binary, session, ["eval", "performance.timeOrigin", "--json"]);
    if (probe.status !== 0) continue;
    try {
      if (evalResult(probe.stdout) === tab.timeOrigin) return { ...candidate, active: true };
    } catch {}
  }
  throw new Error(`could not find terminal browser tab ${tab.id} (${tab.url}) among agent-browser's tabs`);
}

async function select(terminal: Terminal | null, options: ActionOptions): Promise<Selection> {
  const all = await browsers(terminal);
  if (all.length === 0) throw new Error("no terminal browsers running — start one with: terminal-browser open");

  if (options.targetId) {
    for (const browser of all) {
      const tab = (await targets(browser)).find((entry) => entry.targetId === options.targetId);
      if (tab) return { browser, tab };
    }
    throw new Error(`no tab with target id ${options.targetId}`);
  }

  let candidates = all;
  if (options.browserKey) {
    candidates = all.filter((browser) => recordKey(browser) === options.browserKey);
    if (candidates.length === 0) {
      throw new Error(
        `no browser ${options.browserKey}\n\nrunning:\n  ${all.map(describe).join("\n  ")}`,
      );
    }
  } else {
    const here = all.filter((browser) => browser.inCurrentTab);
    if (here.length === 0) {
      throw new Error(
        `no terminal browser in this terminal tab — pass --browser <key>\n\nrunning:\n  ${all
          .map(describe)
          .join("\n  ")}`,
      );
    }
    candidates = here;
  }
  if (candidates.length > 1) {
    throw new Error(
      `several browsers match — pass --browser <key>\n\nmatching:\n  ${candidates
        .map(describe)
        .join("\n  ")}`,
    );
  }

  const browser = candidates[0];
  const tabs = await targets(browser);
  if (tabs.length === 0) throw new Error(`browser ${recordKey(browser)} has no tabs`);
  if (options.tabId === undefined) {
    return { browser, tab: tabs.find((tab) => tab.active) ?? tabs[0] };
  }
  const tab = tabs.find((entry) => entry.id === options.tabId);
  if (!tab) {
    const known = tabs.map((entry) => `${entry.id} ${entry.url}`).join("\n  ");
    throw new Error(`no tab ${options.tabId} in browser ${recordKey(browser)}\n\ntabs:\n  ${known}`);
  }
  return { browser, tab };
}

const BLOCKED_COMMANDS = new Map([
  ["launch", "terminal-browser drives the browser you already have open — use: terminal-browser open"],
  ["install", "terminal-browser never downloads a second browser engine"],
  ["connect", "terminal-browser manages the CDP connection for you"],
  ["disconnect", "terminal-browser manages the CDP connection for you"],
]);

const BLOCKED_FLAGS = new Map([
  ["--cdp", "terminal-browser picks the port from the browser you target"],
  ["--auto-connect", "terminal-browser picks the port from the browser you target"],
  ["--session", "terminal-browser names the session after the browser you target"],
  ["--headed", "the browser is already visible in your terminal"],
  ["--executable-path", "terminal-browser drives its own browser, not another engine"],
  ["--profile", "terminal-browser drives its own browser, not another engine"],
  ["--provider", "terminal-browser drives the local browser, not a cloud one"],
]);

// Every flag agent-browser's commands take, plus the output-only global flags.
// Anything else (launch options, config files, providers) could make
// agent-browser leave this browser, so it is refused.
const ALLOWED_FLAGS = new Set([
  "--json", "--max-output", "--content-boundaries", "--annotate", "-v", "--verbose", "-q", "--quiet",
  "--abort", "--all", "--bail", "--base64", "--baseline", "--body", "--categories", "--clear", "--compact",
  "--contact-sheet", "--contact-sheet-threshold", "--content", "--cookie", "--credential-provider", "--curl",
  "--cursor", "--delay", "--delta", "--depth", "--domain", "--duration", "--exact", "--expires",
  "--filter", "--fn", "--frame", "--full", "--httpOnly", "--human", "--if-changed", "--interactive",
  "--item", "--label", "--llms", "--load", "--method", "--name", "--new-tab", "--no-navigate", "--older-than",
  "--only-dynamic", "--outline", "--output", "--params", "--password", "--password-selector", "--password-stdin",
  "--path", "--raw", "--raw-json", "--require-md", "--resource-type", "--resource-types", "--sameSite",
  "--screenshot", "--secure", "--seed", "--selector", "--smooth", "--status", "--stdin", "--steps",
  "--submit-selector", "--tags", "--text", "--threshold", "--timeout", "--type", "--url", "--urls",
  "--username", "--username-selector", "--wait-until",
  "-C", "-H", "-a", "-b", "-c", "-d", "-f", "-i", "-l", "-o", "-s", "-t", "-u",
]);

// The commands that drive the attached browser. The patched agent-browser
// keeps the same list; plugins, installers, upgrades and servers are not on it.
const ALLOWED_COMMANDS = new Set([
  "open", "goto", "navigate", "back", "forward", "reload", "read", "click", "dblclick", "fill",
  "type", "hover", "focus", "check", "uncheck", "select", "drag", "upload", "download", "press",
  "key", "keydown", "keyup", "keyboard", "scroll", "scrollintoview", "scrollinto", "wait",
  "screenshot", "pdf", "snapshot", "eval", "close", "quit", "exit", "confirm", "deny", "get",
  "is", "find", "mouse", "set", "network", "storage", "cookies", "tab", "window", "frame",
  "dialog", "trace", "profiler", "record", "console", "errors", "highlight", "clipboard",
  "state", "diff", "batch", "react", "vitals", "web-vitals", "a11y", "pushstate",
  "removeinitscript", "webmcp",
]);

// agent-browser's own global flags (flags.rs clean_args): these take a value,
// and these take an optional true/false, so neither value is the command.
const GLOBAL_VALUE_FLAGS = new Set([
  "--session", "--restore-save", "--restore-check-url", "--restore-check-text", "--restore-check-fn",
  "--namespace", "--headers", "--executable-path", "--cdp", "--extension", "--init-script", "--enable",
  "--profile", "--state", "--proxy", "--proxy-bypass", "--args", "--user-agent", "-p", "--provider",
  "--device", "--session-name", "--color-scheme", "--download-path", "--max-output", "--allowed-domains",
  "--action-policy", "--confirm-actions", "--config", "--engine", "--input-mode", "--screenshot-dir",
  "--screenshot-quality", "--screenshot-format", "--idle-timeout", "--ca-cert", "--model",
]);
const GLOBAL_BOOL_FLAGS = new Set([
  "--json", "--headed", "--webgpu", "--no-webmcp", "--debug", "--ignore-https-errors", "--allow-file-access",
  "--hide-scrollbars", "--auto-connect", "--pin-tab", "--no-pin-tab", "--no-ca-cert", "--annotate",
  "--content-boundaries", "--confirm-interactive", "--no-auto-dialog", "-v", "--verbose", "-q", "--quiet",
  "--offline", "--quick", "--fix",
]);

export function cleanArgs(args: string[]): string[] {
  const clean: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (GLOBAL_VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (arg === "--restore" || arg.startsWith("--restore=")) continue;
    if (GLOBAL_BOOL_FLAGS.has(arg)) {
      if (args[i + 1] === "true" || args[i + 1] === "false") i++;
      continue;
    }
    clean.push(arg);
  }
  return clean;
}

// agent-browser's batch entries are split like commands.rs shell_words_split.
export function shellWordsSplit(text: string): string[] {
  const words: string[] = [];
  let current = "";
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && !inSingle) {
      if (i + 1 < text.length) current += text[++i];
    } else if (c === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (c === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (c === " " && !inDouble && !inSingle) {
      if (current) words.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  if (current) words.push(current);
  return words;
}

export function checkGuardrails(args: string[], insideBatch = false) {
  for (const arg of args) {
    if (!arg.startsWith("-") || /^-\d/.test(arg)) continue;
    const flag = arg.split("=")[0];
    const reason = BLOCKED_FLAGS.get(flag);
    if (reason) throw new Error(`${flag} is not available through terminal-browser action — ${reason}`);
    // fixme: placeholder copy
    if (!ALLOWED_FLAGS.has(flag)) throw new Error(`${flag} is not available through terminal-browser action`);
  }
  const [command, ...rest] = cleanArgs(args);
  if (command === undefined) return;
  const reason = BLOCKED_COMMANDS.get(command);
  if (reason) throw new Error(`${command} is not available through terminal-browser action — ${reason}`);
  // fixme: placeholder copy
  if (!ALLOWED_COMMANDS.has(command)) throw new Error(`${command} is not available through terminal-browser action`);
  if (command !== "batch") return;
  // fixme: placeholder copy
  if (insideBatch) throw new Error("batch is not available inside a batch");
  const entries = rest.filter((arg) => arg !== "--bail");
  // fixme: placeholder copy
  if (entries.length === 0) throw new Error("batch needs its commands as arguments through terminal-browser action");
  for (const entry of entries) checkGuardrails(shellWordsSplit(entry), true);
}

async function interceptTabLifecycle(
  selection: Selection,
  args: string[],
): Promise<unknown | null> {
  const positional = cleanArgs(args).filter((arg) => !arg.startsWith("-"));
  const [command, sub, value] = positional;
  if (command === "open") {
    return control(selection.browser.socket, { cmd: "open-tab", url: sub });
  }
  if (command !== "tab") return null;
  if (sub === "new") {
    return control(selection.browser.socket, { cmd: "open-tab", url: value });
  }
  if (sub === "close") {
    const id = value ? Number(value.replace(/^t/, "")) : selection.tab.id;
    if (!Number.isFinite(id)) throw new Error(`cannot read a tab id from ${value}`);
    return control(selection.browser.socket, { cmd: "close-tab", tab: id });
  }
  return null;
}

export async function actionCommand(terminal: Terminal | null, options: ActionOptions) {
  const selection = await select(terminal, options);
  const { browser, tab } = selection;

  if (options.done) {
    const reply = await control(browser.socket, { cmd: "agent-release" });
    outJson(reply);
    return 0;
  }

  if (options.passthrough.length === 0) {
    throw new Error("nothing to run — pass a command after --, e.g. terminal-browser action -- snapshot");
  }
  checkGuardrails(options.passthrough);
  await control(browser.socket, { cmd: "agent-touch", tab: tab.id }).catch(() => {});

  const intercepted = await interceptTabLifecycle(selection, options.passthrough);
  if (intercepted !== null) {
    outJson(intercepted);
    return 0;
  }

  if (!fs.existsSync(cdpSocket())) {
    // fixme: placeholder copy
    throw new Error(`browser ${recordKey(browser)} has no debugging socket`);
  }
  if (!tab.targetId) {
    throw new Error(`tab ${tab.id} has no CDP target yet — is the page still starting?`);
  }

  const binary = agentBrowserPath();
  const session = sessionName(browser);
  const match = matchTab(binary, session, agentTabs(binary, browser), tab);
  if (!match.active) {
    const switched = runAgent(binary, session, ["tab", match.tabId]);
    if (switched.status !== 0) throw new Error(`agent-browser could not switch to ${match.tabId}`);
  }
  if (options.follow && !tab.active) {
    await control(browser.socket, { cmd: "activate-tab", tab: tab.id });
  }

  const json = options.passthrough.includes("--json");
  return withArgsOnFd(agentArgs(session, options.passthrough), (fd) =>
    runRelayed(binary, [], agentEnv(), { argsFd: fd, json }),
  );
}
