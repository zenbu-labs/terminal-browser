import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();


function base(variable: string, fallback: string): string {
  const value = process.env[variable];
  return value && path.isAbsolute(value) ? value : path.join(HOME, fallback);
}

const DATA_HOME = base("XDG_DATA_HOME", ".local/share");
const STATE_HOME = base("XDG_STATE_HOME", ".local/state");
const CACHE_HOME = base("XDG_CACHE_HOME", ".cache");

const RUNTIME_HOME = process.env.XDG_RUNTIME_DIR ?? STATE_HOME;

function installRoot(): { root: string; dev: boolean } {
  const dist = process.env.TERMINAL_BROWSER_DIST_ROOT;
  if (dist) return { root: physical(dist), dev: false };
  for (let dir = __dirname; path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return { root: dir, dev: true };
  }
  return { root: physical(__dirname), dev: true };
}

function physical(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

export const INSTALL_ROOT = installRoot();

function stableIdentity(root: string): string {
  return root.replace(/([/\\]Caskroom[/\\]terminal-browser[/\\])[^/\\]+/, "$1");
}

const suffix = crypto.createHash("sha256").update(stableIdentity(INSTALL_ROOT.root)).digest("hex").slice(0, 8);

export const APP_DIR_NAME = `terminal-browser${INSTALL_ROOT.dev ? "-dev" : ""}-${suffix}`;

export const DATA_DIR = path.join(DATA_HOME, APP_DIR_NAME);
export const LOGS_DIR = path.join(STATE_HOME, APP_DIR_NAME, "logs");
export const FAVICONS_DIR = path.join(CACHE_HOME, APP_DIR_NAME, "favicons");
export const ADBLOCK_DIR = path.join(CACHE_HOME, APP_DIR_NAME, "adblock");
export const INSTANCES_DIR = path.join(RUNTIME_HOME, APP_DIR_NAME, "instances");
export const AGENT_SOCKETS_DIR = path.join(RUNTIME_HOME, APP_DIR_NAME, "agent-browser");
export const DAEMON_SOCKET = path.join(RUNTIME_HOME, APP_DIR_NAME, "daemon.sock");
export const DB_FILE = path.join(DATA_DIR, "terminal-browser.db");

export function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, "install"), `${INSTALL_ROOT.root}\n`);
}
