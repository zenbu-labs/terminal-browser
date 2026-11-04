import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureOwnedDir, reclaimPrivateDir, tightenOwnedDir } from "@zenbu-labs/pixel/private-dir";

import { tightenPrivateFile, tightenPrivateFiles, writePrivateFile } from "./private-files";

const HOME = os.homedir();


function base(variable: string, fallback: string): string {
  const value = process.env[variable];
  return value && path.isAbsolute(value) ? value : path.join(HOME, fallback);
}

const DATA_HOME = base("XDG_DATA_HOME", ".local/share");
const STATE_HOME = base("XDG_STATE_HOME", ".local/state");
const CACHE_HOME = base("XDG_CACHE_HOME", ".cache");
const CONFIG_HOME = base("XDG_CONFIG_HOME", ".config");

const RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
const RUNTIME_HOME = RUNTIME_DIR && path.isAbsolute(RUNTIME_DIR) ? RUNTIME_DIR : STATE_HOME;

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
const STATE_DIR = path.join(STATE_HOME, APP_DIR_NAME);
export const LOGS_DIR = path.join(STATE_DIR, "logs");
export const FAVICONS_DIR = path.join(CACHE_HOME, APP_DIR_NAME, "favicons");
export const INSTANCES_DIR = path.join(RUNTIME_HOME, APP_DIR_NAME, "instances");
export const AGENT_SOCKETS_DIR = path.join(RUNTIME_HOME, APP_DIR_NAME, "agent-browser");
export const BRIDGE_SOCKETS_DIR = path.join(RUNTIME_HOME, APP_DIR_NAME, "bridge");
export const DAEMON_SOCKET = path.join(RUNTIME_HOME, APP_DIR_NAME, "daemon.sock");
export const CDP_SOCKET = path.join(RUNTIME_HOME, APP_DIR_NAME, "cdp", "cdp.sock");
export const DB_FILE = path.join(DATA_DIR, "terminal-browser.db");
export const EXTENSIONS_DIR = path.join(DATA_DIR, "extensions");

function configDir(): string {
  const override = process.env.TERMINAL_BROWSER_CONFIG_DIR;
  return override && path.isAbsolute(override) ? override : path.join(CONFIG_HOME, "terminal-browser");
}

export const CONFIG_DIR = configDir();
export const SETTINGS_FILE = path.join(CONFIG_DIR, "settings.json");
export const SHORTCUTS_FILE = path.join(CONFIG_DIR, "shortcuts.json");

export function tightenDatabaseFiles(file: string = DB_FILE): void {
  const base = path.basename(file);
  tightenPrivateFiles(
    path.dirname(file),
    (name) => name === base || name.startsWith(`${base}-`) || name.startsWith(`${base}.bak-`),
  );
}

export function ensureDataDir(): void {
  reclaimPrivateDir(DATA_DIR);
  tightenOwnedDir(EXTENSIONS_DIR);
  tightenDatabaseFiles();
  writePrivateFile(path.join(DATA_DIR, "install"), `${INSTALL_ROOT.root}\n`);
}

export function ensureLogsDir(): void {
  reclaimPrivateDir(STATE_DIR);
  reclaimPrivateDir(LOGS_DIR);
  tightenPrivateFiles(LOGS_DIR);
}

function isSymlink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

// The config folder and files may be links into the user's dotfiles, which we leave as they set them up.
export function ensureConfigDir(dir: string = CONFIG_DIR): void {
  if (!isSymlink(dir)) ensureOwnedDir(dir);
}

export function writeConfigFile(file: string, text: string): void {
  ensureConfigDir(path.dirname(file));
  if (isSymlink(file)) fs.writeFileSync(file, text);
  else writePrivateFile(file, text);
}

function tightenConfig(): void {
  if (!isSymlink(CONFIG_DIR)) tightenOwnedDir(CONFIG_DIR);
  for (const file of [SETTINGS_FILE, SHORTCUTS_FILE]) if (!isSymlink(file)) tightenPrivateFile(file);
}

// Makes everything we keep for this user readable only by them, including
// files an older version created with looser permissions.
export function ensurePrivateState(): void {
  ensureDataDir();
  ensureLogsDir();
  tightenConfig();
}
