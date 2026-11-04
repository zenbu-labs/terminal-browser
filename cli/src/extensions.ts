import fs from "node:fs";
import type net from "node:net";
import path from "node:path";
import readline from "node:readline";

import { connectPrivately } from "@zenbu-labs/pixel/private-socket";
import {
  CrxError,
  DAEMON_SOCKET,
  EXTENSIONS_DIR,
  ManifestError,
  checkManifest,
  ensurePrivateDir,
  deleteExtension,
  directoryDisplayName,
  downloadStoreUpdates,
  extensionIdForDirectory,
  fetchStorePackage,
  findImportSource,
  findImports,
  getExtension,
  importDisabledReason,
  importableItems,
  installWarnings,
  newPermissionWarnings,
  isExtensionId,
  listExtensions,
  readCrxFile,
  readInstalledManifest,
  readManifestFile,
  recordForPackage,
  removeOtherVersions,
  restoreExtension,
  saveExtension,
  setExtensionAcceptedPermissions,
  unpackPackage,
  updateExtension,
} from "shared";
import type { DisabledReason, ExtensionPackage, ExtensionRecord, ImportBrowser, ImportItem, ImportProfile, UpdateResult } from "shared";

import { err, oneLine, out as write, outJson } from "./output";

// The parts of the daemon's ExtensionSummary that `list` shows.
interface Listed {
  id: string;
  name: string;
  version: string;
  source: ExtensionRecord["source"];
  path: string;
  enabled: boolean;
  disabledReason: ExtensionRecord["disabledReason"];
  pinned: boolean;
  errors: string[];
}

class UsageError extends Error {}

function out(line = "") {
  write(`${oneLine(line)}\n`);
}

function takeBool(args: string[], ...names: string[]): boolean {
  let found = false;
  for (const name of names) {
    const at = args.indexOf(name);
    if (at >= 0) {
      args.splice(at, 1);
      found = true;
    }
  }
  return found;
}

function takeValue(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("-")) throw new UsageError(`${name} needs a value`);
  args.splice(at, 2);
  return value;
}

function daemonRequest(message: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let socket: net.Socket | null = null;
    const timer = setTimeout(() => {
      socket?.destroy();
      reject(new Error("the browser did not answer"));
    }, timeoutMs);
    const fail = (error: unknown) => {
      clearTimeout(timer);
      reject(error);
    };
    connectPrivately(DAEMON_SOCKET).then((connected) => {
      socket = connected;
      let buffer = "";
      connected.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timer);
        connected.end();
        const reply = JSON.parse(buffer.slice(0, newline)) as { ok: boolean; data?: unknown; error?: string };
        if (reply.ok) resolve(reply.data ?? null);
        else reject(new Error(reply.error ?? "failed"));
      });
      connected.on("error", fail);
      connected.write(`${JSON.stringify({ cmd: "extensions", ...message })}\n`);
    }, fail);
  });
}

function daemonRunning(): Promise<boolean> {
  ensurePrivateDir(path.dirname(DAEMON_SOCKET));
  return connectPrivately(DAEMON_SOCKET).then(
    (probe) => {
      probe.end();
      return true;
    },
    () => false,
  );
}

// Runs an action in the browser when one is open, so it applies right away.
// Returns undefined when no browser is running.
async function inBrowser(message: Record<string, unknown>, timeoutMs = 20_000): Promise<unknown | undefined> {
  if (!(await daemonRunning())) return undefined;
  return daemonRequest(message, timeoutMs);
}

async function confirm(question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    throw new UsageError("Pass --yes to confirm when not running interactively.");
  }
  const ask = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    ask.question(`${oneLine(question)} [y/N] `, resolve);
    ask.on("close", () => resolve("n"));
  });
  ask.close();
  return /^(y|yes)$/i.test(answer.trim());
}

function requireRecord(id: string | undefined): ExtensionRecord {
  if (!id) throw new UsageError("missing extension id (see terminal-browser extensions list)");
  const record = getExtension(id);
  if (!record) throw new UsageError(`no extension with id ${id} (see terminal-browser extensions list)`);
  return record;
}

function sourceLabel(source: ExtensionRecord["source"]): string {
  return source === "crx" ? "dev crx" : source;
}

function statusLabel(entry: Pick<Listed, "enabled" | "disabledReason">): string {
  if (entry.enabled) return "enabled";
  if (entry.disabledReason === "permissions_increase") return "disabled (needs new permissions)";
  if (entry.disabledReason === "load_error") return "disabled (failed to load)";
  return "disabled";
}

function localListing(): Listed[] {
  return listExtensions().map((record) => ({
    id: record.id,
    name: record.name,
    version: record.version,
    source: record.source,
    path: record.path,
    enabled: record.enabled,
    disabledReason: record.disabledReason,
    pinned: record.pinned,
    errors: [],
  }));
}

async function listCommand(args: string[]): Promise<number> {
  const json = takeBool(args, "--json");
  rejectExtra(args);
  const fromBrowser = (await inBrowser({ action: "list" }).catch(() => undefined)) as Listed[] | undefined;
  const entries = fromBrowser ?? localListing();
  if (json) {
    const fields = entries.map(({ id, name, version, source, path: dir, enabled, disabledReason, pinned, errors }) => ({
      id,
      name,
      version,
      source,
      path: dir,
      enabled,
      disabledReason,
      pinned,
      errors,
    }));
    outJson(fields);
    return 0;
  }
  if (entries.length === 0) {
    out("no extensions installed");
    return 0;
  }
  const header = ["id", "name", "version", "status", "source"];
  const rows = entries.map((entry) => [entry.id, entry.name, entry.version, statusLabel(entry), sourceLabel(entry.source)].map(oneLine));
  const widths = header.map((label, col) => Math.max(label.length, ...rows.map((row) => row[col].length)));
  for (const row of [header, ...rows]) out(row.map((cell, col) => cell.padEnd(widths[col])).join("  ").trimEnd());
  for (const entry of entries) {
    if (entry.errors.length === 0) continue;
    out();
    out(`${entry.name} errors:`);
    for (const error of entry.errors.slice(-10)) out(`  ${error}`);
  }
  return 0;
}

function rejectExtra(args: string[]) {
  if (args.length > 0) throw new UsageError(`unexpected ${args[0]} (see terminal-browser extensions --help)`);
}

function storeId(target: string): string | null {
  if (isExtensionId(target)) return target;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (url.hostname !== "chromewebstore.google.com" && url.hostname !== "chrome.google.com") return null;
  const id = url.pathname.split("/").find((part) => isExtensionId(part));
  return id ?? null;
}

function describePackage(pkg: ExtensionPackage) {
  const origin = pkg.fromWebStore ? "" : " (not from the Chrome Web Store)";
  out(`${pkg.name} ${pkg.version}${origin}`);
  const warnings = installWarnings(pkg.manifest);
  if (warnings.length > 0) {
    out("It can:");
    for (const warning of warnings) out(`  ${warning}`);
  }
}

async function installCommand(args: string[]): Promise<number> {
  const yes = takeBool(args, "--yes", "-y");
  const [target, ...rest] = args;
  rejectExtra(rest);
  if (!target) throw new UsageError("install needs an extension id, a Chrome Web Store url or a .crx file");
  let pkg: ExtensionPackage;
  const id = storeId(target);
  if (id) {
    const existing = getExtension(id);
    if (existing) {
      out(`${existing.name} is already installed`);
      return 0;
    }
    pkg = await fetchStorePackage(id);
  } else if (fs.existsSync(target)) {
    pkg = readCrxFile(path.resolve(target));
  } else {
    throw new UsageError(`${target} is not an extension id, a Chrome Web Store url or a file`);
  }
  describePackage(pkg);
  if (!(await confirm(`Install ${pkg.name}?`, yes))) {
    out("cancelled");
    return 0;
  }
  const previous = getExtension(pkg.id);
  const dir = unpackPackage(pkg);
  saveExtension(recordForPackage(pkg, dir));
  try {
    await inBrowser({ action: "installed", id: pkg.id, previousVersion: previous?.version });
  } catch (error) {
    restoreExtension(pkg.id, previous, dir);
    await inBrowser({ action: "reconcile" }).catch(() => undefined);
    throw error;
  }
  removeOtherVersions(pkg.id, dir);
  out(`installed ${pkg.name} ${pkg.version} (${pkg.id})`);
  return 0;
}

async function loadCommand(args: string[]): Promise<number> {
  const [target, ...rest] = args;
  rejectExtra(rest);
  if (!target) throw new UsageError("load needs the extension's directory");
  const dir = path.resolve(target);
  if (!fs.existsSync(path.join(dir, "manifest.json"))) throw new UsageError(`no manifest.json in ${dir}`);
  const manifest = readManifestFile(dir);
  checkManifest(manifest, path.join(dir, "manifest.json"), true);
  const loaded = (await inBrowser({ action: "load", dir })) as { id: string; name: string; version: string } | undefined;
  if (loaded) {
    out(`loaded ${loaded.name} ${loaded.version} (${loaded.id})`);
    return 0;
  }
  const resolved = fs.realpathSync(dir);
  const id = extensionIdForDirectory(resolved, manifest);
  const existing = getExtension(id);
  const now = Date.now();
  const name = directoryDisplayName(resolved, manifest);
  saveExtension({
    id,
    path: resolved,
    version: String(manifest.version),
    name,
    source: "unpacked",
    enabled: true,
    disabledReason: null,
    pinned: existing?.pinned ?? true,
    grantedPermissions: existing?.grantedPermissions ?? [],
    grantedOrigins: existing?.grantedOrigins ?? [],
    shortcuts: existing?.shortcuts ?? {},
    installedAt: existing?.installedAt ?? now,
    updatedAt: now,
    lastUpdateCheck: null,
    userScriptsAllowed: existing?.userScriptsAllowed ?? false,
  });
  out(`loaded ${name} ${String(manifest.version)} (${id})`);
  return 0;
}

async function removeCommand(args: string[]): Promise<number> {
  const yes = takeBool(args, "--yes", "-y");
  const [id, ...rest] = args;
  rejectExtra(rest);
  const record = requireRecord(id);
  if (!(await confirm(`Remove ${record.name}?`, yes))) {
    out("cancelled");
    return 0;
  }
  const done = await inBrowser({ action: "remove", id: record.id });
  if (done === undefined) {
    deleteExtension(record.id);
    const managed = path.resolve(EXTENSIONS_DIR, record.id);
    if (record.path.startsWith(`${managed}${path.sep}`)) fs.rmSync(managed, { recursive: true, force: true });
  }
  out(`removed ${record.name}`);
  return 0;
}

async function setEnabledCommand(args: string[], enabled: boolean): Promise<number> {
  const yes = takeBool(args, "--yes", "-y");
  const [id, ...rest] = args;
  rejectExtra(rest);
  const record = requireRecord(id);
  const needsPermission = enabled && record.disabledReason === "permissions_increase";
  if (needsPermission) {
    const manifest = readInstalledManifest(record);
    out(`${record.name} ${record.version} asks for new permissions`);
    const warnings = manifest ? newPermissionWarnings(record.id, manifest) : [];
    if (warnings.length > 0) {
      out("It can:");
      for (const warning of warnings) out(`  ${warning}`);
    }
    if (!(await confirm(`Enable ${record.name}?`, yes))) {
      out("cancelled");
      return 0;
    }
  }
  const done = await inBrowser({ action: enabled ? "enable" : "disable", id: record.id });
  if (done === undefined) {
    updateExtension(record.id, { enabled, disabledReason: enabled ? null : "user" });
    if (enabled) setExtensionAcceptedPermissions(record.id, null);
    if (needsPermission) removeOtherVersions(record.id, record.path);
  }
  out(`${enabled ? "enabled" : "disabled"} ${record.name}`);
  return 0;
}

async function pinCommand(args: string[], pinned: boolean): Promise<number> {
  const [id, ...rest] = args;
  rejectExtra(rest);
  const record = requireRecord(id);
  const done = await inBrowser({ action: pinned ? "pin" : "unpin", id: record.id });
  if (done === undefined) updateExtension(record.id, { pinned });
  out(`${pinned ? "pinned" : "unpinned"} ${record.name}`);
  return 0;
}

async function updateCommand(args: string[]): Promise<number> {
  const [id, ...rest] = args;
  rejectExtra(rest);
  if (id) {
    const record = requireRecord(id);
    if (record.source !== "webstore") throw new UsageError(`${record.name} is not from the Chrome Web Store, so it has no updates`);
  }
  let results = (await inBrowser({ action: "update", id }, 300_000)) as UpdateResult[] | undefined;
  if (results === undefined) {
    results = await downloadStoreUpdates(listExtensions().filter((record) => !id || record.id === id));
    for (const result of results) {
      if (result.status === "updated" && result.record) removeOtherVersions(result.id, result.record.path);
    }
  }
  if (results.length === 0) {
    out("everything is up to date");
    return 0;
  }
  let failed = false;
  for (const result of results) {
    if (result.status === "updated") out(`updated ${result.name} ${result.previousVersion} -> ${result.version}`);
    else if (result.status === "needs_permission") {
      out(`${result.name} ${result.version} asks for new permissions, so it is disabled until you run: terminal-browser extensions enable ${result.id}`);
    } else {
      failed = true;
      out(`could not update ${result.name}: ${result.error ?? "unknown error"}`);
    }
  }
  return failed ? 1 : 0;
}

async function reloadCommand(args: string[]): Promise<number> {
  const [id, ...rest] = args;
  rejectExtra(rest);
  if (id) requireRecord(id);
  const result = (await inBrowser({ action: "reload", id })) as { reloaded: string[]; failed: Record<string, string[]> } | undefined;
  if (result === undefined) {
    out("no browser is running, so there is nothing to reload");
    return 0;
  }
  for (const reloaded of result.reloaded) {
    const record = getExtension(reloaded);
    const errors = result.failed[reloaded];
    if (errors) {
      out(`${record?.name ?? reloaded} failed to load:`);
      for (const error of errors) out(`  ${error}`);
    } else out(`reloaded ${record?.name ?? reloaded}`);
  }
  if (result.reloaded.length === 0) out("no unpacked extensions to reload");
  return Object.keys(result.failed).length > 0 ? 1 : 0;
}

const IMPORT_STATUS = {
  add: "will be installed",
  addOff: "will be installed, off",
  installed: "already installed",
  unpacked: "unpacked",
  not_on_store: "not on the Chrome Web Store",
};

interface ImportSource {
  browser: ImportBrowser;
  profile: ImportProfile;
}

function importNote(id: string, disabledReason: DisabledReason | null, enabledInSource: boolean): string {
  // fixme: placeholder copy
  if (disabledReason === "permissions_increase" && enabledInSource) return ` (needs approval, run: terminal-browser extensions enable ${id})`;
  return disabledReason ? " (off)" : "";
}

function importSourceLabel(source: ImportSource): string {
  return source.browser.profiles.length > 1 ? `${source.browser.name}, ${source.profile.name}` : source.browser.name;
}

function itemLabel(item: ImportItem, adding: boolean): string {
  if (adding) return item.enabled ? IMPORT_STATUS.add : IMPORT_STATUS.addOff;
  if (item.status === "installed") return IMPORT_STATUS.installed;
  return IMPORT_STATUS[item.reason ?? "not_on_store"];
}

function pickSources(browsers: ImportBrowser[], from: string | undefined, profile: string | undefined, all: boolean): ImportSource[] {
  let sources = browsers
    .filter((browser) => !from || browser.key === from)
    .flatMap((browser) => browser.profiles.map((entry) => ({ browser, profile: entry })));
  if (profile) {
    const named = sources.filter((source) => source.profile.name === profile || source.profile.key === profile);
    if (named.length === 0) {
      throw new UsageError(`no profile named ${profile} (found: ${sources.map((source) => source.profile.name).join(", ")})`);
    }
    sources = named;
  }
  const importable = sources.filter((source) => importableItems(source.profile.items).length > 0);
  if (all || importable.length <= 1) return importable.length > 0 ? importable : sources;
  out("Found:");
  const keyWidth = Math.max(...importable.map((source) => source.browser.key.length));
  const profileWidth = Math.max(...importable.map((source) => source.profile.name.length));
  for (const source of importable) {
    const count = importableItems(source.profile.items).length;
    out(`  ${source.browser.key.padEnd(keyWidth)}  ${source.profile.name.padEnd(profileWidth)}  ${count} to import`);
  }
  throw new UsageError("pick one with --from <browser> --profile <name>, or pass --all");
}

async function importCommand(args: string[]): Promise<number> {
  const yes = takeBool(args, "--yes", "-y");
  const all = takeBool(args, "--all");
  const from = takeValue(args, "--from");
  const profile = takeValue(args, "--profile");
  rejectExtra(args);
  const browsers = await findImports();
  if (browsers.length === 0) {
    out("no browsers found");
    return 0;
  }
  if (from && !browsers.some((browser) => browser.key === from)) {
    throw new UsageError(`${from} was not found (found: ${browsers.map((browser) => browser.key).join(", ")})`);
  }
  const sources = pickSources(browsers, from, profile, all);
  const planned = new Map<string, { item: ImportItem; source: ImportSource }>();
  for (const source of sources) {
    const adding = new Set(importableItems(source.profile.items));
    out(`${importSourceLabel(source)}:`);
    if (source.profile.items.length === 0) out("  nothing to import");
    const width = Math.max(0, ...source.profile.items.map((item) => item.name.length));
    for (const item of source.profile.items) {
      const add = adding.has(item) && (!planned.has(item.id) || (item.enabled && !planned.get(item.id)!.item.enabled));
      if (add) planned.set(item.id, { item, source });
      out(`  ${item.name.padEnd(width)}  ${itemLabel(item, adding.has(item))}`);
    }
  }
  if (planned.size === 0) {
    out("nothing to import");
    return 0;
  }
  out();
  const plan = [...planned.values()];
  const items = plan.map((entry) => entry.item);
  if (!(await confirm(items.length === 1 ? `Install ${items[0].name}?` : `Install ${items.length} extensions?`, yes))) {
    out("cancelled");
    return 0;
  }
  let failed = false;
  for (const { item, source } of plan) {
    try {
      if (getExtension(item.id)) {
        out(`${item.name} is already installed`);
        continue;
      }
      const found = findImportSource(source.browser.key, source.profile.key, item.id);
      // fixme: placeholder copy
      if (!found || found.item.status !== "ready") throw new Error(`it is no longer in ${importSourceLabel(source)}`);
      const pkg = await fetchStorePackage(item.id);
      const disabledReason = importDisabledReason(found, pkg.manifest);
      const dir = unpackPackage(pkg);
      setExtensionAcceptedPermissions(pkg.id, disabledReason === "permissions_increase" ? found.accepted : null);
      saveExtension(recordForPackage(pkg, dir, disabledReason ? { enabled: false, disabledReason } : {}));
      try {
        await inBrowser({ action: "installed", id: pkg.id });
      } catch (error) {
        restoreExtension(pkg.id, null, dir);
        throw error;
      }
      removeOtherVersions(pkg.id, dir);
      out(`installed ${pkg.name} ${pkg.version}${importNote(pkg.id, disabledReason, found.item.enabled)}`);
    } catch (error) {
      failed = true;
      out(`could not install ${item.name}: ${friendly(error)}`);
    }
  }
  return failed ? 1 : 0;
}

function friendly(error: unknown): string {
  if (error instanceof CrxError) {
    if (error.code === "bad_signature" || error.code === "missing_proof") return `signature check failed: ${error.message}`;
    return error.message;
  }
  if (error instanceof ManifestError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export async function extensionsCommand(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  try {
    switch (action) {
      case "list":
        return await listCommand(rest);
      case "install":
        return await installCommand(rest);
      case "import":
        return await importCommand(rest);
      case "load":
        return await loadCommand(rest);
      case "remove":
        return await removeCommand(rest);
      case "enable":
        return await setEnabledCommand(rest, true);
      case "disable":
        return await setEnabledCommand(rest, false);
      case "update":
        return await updateCommand(rest);
      case "reload":
        return await reloadCommand(rest);
      case "pin":
        return await pinCommand(rest, true);
      case "unpin":
        return await pinCommand(rest, false);
      default:
        throw new UsageError(action ? `unknown extensions command ${action} (see terminal-browser extensions --help)` : "missing command (see terminal-browser extensions --help)");
    }
  } catch (error) {
    err(`terminal-browser: ${oneLine(friendly(error))}\n`);
    return 1;
  }
}
