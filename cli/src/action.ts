import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { AGENT_SOCKETS_DIR } from "pixel-store";
import type { Backend } from "pixel-terminals";

import { control } from "./control";
import { browsers, describe, recordKey, targets } from "./instances";
import type { Browser, TabTarget } from "./instances";

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
  resolve: boolean;
  printEnv: boolean;
  passthrough: string[];
}

function repoScript(): string {
  return path.resolve(__dirname, "..", "..", "scripts", "agent-browser.sh");
}

export function agentBrowserPath(): string {
  const override = process.env.TERMINAL_BROWSER_AGENT;
  if (override) {
    if (!fs.existsSync(override)) {
      throw new Error(`TERMINAL_BROWSER_AGENT points at a missing file: ${override}`);
    }
    return override;
  }
  if (DIST_ROOT) {
    const shipped = path.join(DIST_ROOT, "agent-browser", "bin", "agent-browser");
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

function childEnv(): NodeJS.ProcessEnv {
  fs.mkdirSync(AGENT_SOCKETS_DIR, { recursive: true });
  return { ...process.env, AGENT_BROWSER_SOCKET_DIR: AGENT_SOCKETS_DIR };
}

function runAgent(binary: string, args: string[]): { status: number; stdout: string } {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    env: childEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.stderr) process.stderr.write(result.stderr);
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
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
  const port = String(browser.cdpPort);
  const listing = runAgent(binary, ["--session", session, "--cdp", port, "tab", "list", "--json"]);
  if (listing.status === 0) {
    try {
      return parseTabs(listing.stdout);
    } catch {}
  }
  const reconnect = runAgent(binary, ["--session", session, "connect", port, "--json"]);
  if (reconnect.status !== 0) {
    throw new Error(`could not connect agent-browser to terminal browser ${recordKey(browser)} on port ${port}`);
  }
  const retry = runAgent(binary, ["--session", session, "tab", "list", "--json"]);
  if (retry.status !== 0) throw new Error("agent-browser could not list tabs after reconnecting");
  return parseTabs(retry.stdout);
}

function matchTab(
  binary: string,
  session: string,
  agentView: AgentTab[],
  tab: TabTarget,
): AgentTab {
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
    runAgent(binary, ["--session", session, "tab", candidate.tabId]);
    const probe = runAgent(binary, [
      "--session",
      session,
      "eval",
      "performance.timeOrigin",
      "--json",
    ]);
    if (probe.status !== 0) continue;
    try {
      if (evalResult(probe.stdout) === tab.timeOrigin) return { ...candidate, active: true };
    } catch {}
  }
  throw new Error(`could not find terminal browser tab ${tab.id} (${tab.url}) among agent-browser's tabs`);
}

async function select(backend: Backend, options: ActionOptions): Promise<Selection> {
  const all = await browsers(backend);
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

function checkGuardrails(args: string[]) {
  for (const arg of args) {
    const flag = arg.split("=")[0];
    const reason = BLOCKED_FLAGS.get(flag);
    if (reason) throw new Error(`${flag} is not available through terminal-browser action — ${reason}`);
  }
  const command = args.find((arg) => !arg.startsWith("-"));
  if (!command) return;
  const reason = BLOCKED_COMMANDS.get(command);
  if (reason) throw new Error(`${command} is not available through terminal-browser action — ${reason}`);
}

async function interceptTabLifecycle(
  selection: Selection,
  args: string[],
): Promise<unknown | null> {
  const positional = args.filter((arg) => !arg.startsWith("-"));
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

export async function actionCommand(backend: Backend, options: ActionOptions) {
  const selection = await select(backend, options);
  const { browser, tab } = selection;

  if (options.resolve) {
    const resolved = {
      browser: recordKey(browser),
      cdpPort: browser.cdpPort,
      socket: browser.socket,
      pane: { window: browser.window, tab: browser.tab, pane: browser.pane },
      tab,
      session: sessionName(browser),
    };
    process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
    return 0;
  }

  if (options.printEnv) {
    process.stdout.write(`AGENT_BROWSER_SOCKET_DIR=${AGENT_SOCKETS_DIR}\n`);
    process.stdout.write(`AGENT_BROWSER_SESSION_NAME=${sessionName(browser)}\n`);
    process.stdout.write(`TERMINAL_BROWSER_TARGET_ID=${tab.targetId ?? ""}\n`);
    return 0;
  }

  if (options.passthrough.length === 0) {
    throw new Error("nothing to run — pass a command after --, e.g. terminal-browser action -- snapshot");
  }
  checkGuardrails(options.passthrough);

  const intercepted = await interceptTabLifecycle(selection, options.passthrough);
  if (intercepted !== null) {
    process.stdout.write(`${JSON.stringify(intercepted, null, 2)}\n`);
    return 0;
  }

  if (browser.cdpPort === null) {
    throw new Error(`browser ${recordKey(browser)} has no debugging port`);
  }
  if (!tab.targetId) {
    throw new Error(`tab ${tab.id} has no CDP target yet — is the page still starting?`);
  }

  const binary = agentBrowserPath();
  const session = sessionName(browser);
  const match = matchTab(binary, session, agentTabs(binary, browser), tab);
  if (!match.active) {
    const switched = runAgent(binary, ["--session", session, "tab", match.tabId]);
    if (switched.status !== 0) throw new Error(`agent-browser could not switch to ${match.tabId}`);
  }
  if (options.follow && !tab.active) {
    await control(browser.socket, { cmd: "activate-tab", tab: tab.id });
  }

  const child = spawnSync(binary, ["--session", session, ...options.passthrough], {
    env: childEnv(),
    stdio: "inherit",
  });
  if (child.error) throw child.error;
  return child.status ?? 1;
}
