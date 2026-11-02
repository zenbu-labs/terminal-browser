import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_PRODVERSION, storeAvailability } from "./crx";
import { directoryDisplayName, permissionsIncreased } from "./extension-install";
import { getExtension, isExtensionId } from "./extensions";
import type { DisabledReason } from "./extensions";
import type { ManifestIcons, RequestedPermissions } from "./manifest";
import { pickIcon } from "./manifest";

export type ImportStatus = "ready" | "installed" | "unavailable";
export type ImportUnavailable = "unpacked" | "not_on_store";

export interface ImportItem {
  id: string;
  name: string;
  enabled: boolean;
  icon: string | null;
  status: ImportStatus;
  reason: ImportUnavailable | null;
}

export interface ImportSource {
  item: ImportItem;
  accepted: RequestedPermissions;
}

export interface ImportProfile {
  key: string;
  name: string;
  items: ImportItem[];
}

export interface ImportBrowser {
  key: string;
  name: string;
  profiles: ImportProfile[];
}

interface BrowserLocation {
  key: string;
  name: string;
  mac?: string;
  linux?: string[];
}

// Chromium-family browsers. mac paths are under ~/Library/Application Support,
// linux ones under ~.
const BROWSERS: BrowserLocation[] = [
  { key: "chrome", name: "Google Chrome", mac: "Google/Chrome", linux: [".config/google-chrome"] },
  { key: "chrome-beta", name: "Google Chrome Beta", mac: "Google/Chrome Beta", linux: [".config/google-chrome-beta"] },
  { key: "chrome-dev", name: "Google Chrome Dev", mac: "Google/Chrome Dev", linux: [".config/google-chrome-unstable"] },
  { key: "chrome-canary", name: "Google Chrome Canary", mac: "Google/Chrome Canary" },
  { key: "chromium", name: "Chromium", mac: "Chromium", linux: [".config/chromium", "snap/chromium/common/chromium"] },
  { key: "arc", name: "Arc", mac: "Arc/User Data" },
  { key: "dia", name: "Dia", mac: "Dia/User Data" },
  { key: "brave", name: "Brave", mac: "BraveSoftware/Brave-Browser", linux: [".config/BraveSoftware/Brave-Browser"] },
  { key: "brave-beta", name: "Brave Beta", mac: "BraveSoftware/Brave-Browser-Beta", linux: [".config/BraveSoftware/Brave-Browser-Beta"] },
  { key: "brave-nightly", name: "Brave Nightly", mac: "BraveSoftware/Brave-Browser-Nightly", linux: [".config/BraveSoftware/Brave-Browser-Nightly"] },
  { key: "edge", name: "Microsoft Edge", mac: "Microsoft Edge", linux: [".config/microsoft-edge"] },
  { key: "edge-beta", name: "Microsoft Edge Beta", mac: "Microsoft Edge Beta", linux: [".config/microsoft-edge-beta"] },
  { key: "edge-dev", name: "Microsoft Edge Dev", mac: "Microsoft Edge Dev", linux: [".config/microsoft-edge-dev"] },
  { key: "edge-canary", name: "Microsoft Edge Canary", mac: "Microsoft Edge Canary" },
  { key: "vivaldi", name: "Vivaldi", mac: "Vivaldi", linux: [".config/vivaldi"] },
  { key: "opera", name: "Opera", mac: "com.operasoftware.Opera", linux: [".config/opera", "snap/opera/current/.config/opera"] },
  { key: "opera-gx", name: "Opera GX", mac: "com.operasoftware.OperaGX" },
  { key: "comet", name: "Comet", mac: "Comet" },
  { key: "helium", name: "Helium", mac: "net.imput.helium", linux: [".config/net.imput.helium"] },
  { key: "thorium", name: "Thorium", mac: "Thorium", linux: [".config/thorium"] },
  { key: "yandex", name: "Yandex Browser", mac: "Yandex/YandexBrowser", linux: [".config/yandex-browser"] },
];

// Chromium's ManifestLocation values (extensions/common/mojom/manifest.mojom).
const LOCATION_UNPACKED = 4;
const LOCATION_COMPONENT = 5;
const LOCATION_COMMAND_LINE = 8;
const LOCATION_EXTERNAL_COMPONENT = 10;

type Json = Record<string, unknown>;

// Other browsers' files are only ever read, never opened for writing.
function readJson(file: string): Json | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : null;
  } catch {
    return null;
  }
}

function object(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function browserRoots(location: BrowserLocation, home: string): string[] {
  if (process.platform === "darwin") return location.mac ? [path.join(home, "Library/Application Support", location.mac)] : [];
  return (location.linux ?? []).map((relative) => path.join(home, relative));
}

function readablePreferences(dir: string): boolean {
  return readJson(path.join(dir, "Secure Preferences")) !== null || readJson(path.join(dir, "Preferences")) !== null;
}

// A browser counts as found only when its Local State and at least one
// profile's preferences can be read.
function chromiumProfiles(root: string): { key: string; name: string; dir: string }[] {
  const localState = readJson(path.join(root, "Local State"));
  if (!localState) return [];
  const profile = object(localState.profile);
  const cache = object(profile.info_cache);
  const order = Array.isArray(profile.profiles_order) ? (profile.profiles_order as unknown[]).filter((key): key is string => typeof key === "string") : [];
  const keys = [...new Set([...order, ...Object.keys(cache)])].filter((key) => key in cache);
  const listed = keys.map((key) => ({ key, name: String(object(cache[key]).name || key), dir: path.join(root, key) }));
  // Opera keeps its only profile in the root folder and lists none.
  const candidates = listed.length > 0 ? listed : [{ key: "Default", name: "Default", dir: path.join(root, "Default") }, { key: "", name: "Default", dir: root }];
  const found = candidates.filter((entry) => readablePreferences(entry.dir));
  return listed.length > 0 ? found : found.slice(0, 1);
}

function iconIn(dir: string, icons: unknown): string | null {
  const relative = pickIcon(icons as ManifestIcons | undefined, 48);
  if (!relative) return null;
  const file = path.resolve(dir, relative.replace(/^\//, ""));
  return file.startsWith(`${dir}${path.sep}`) && fs.existsSync(file) ? file : null;
}

function chromiumEnabled(entry: Json): boolean {
  if ("state" in entry) return entry.state === 1;
  const reasons = entry.disable_reasons;
  return reasons === undefined || reasons === 0 || (Array.isArray(reasons) && reasons.length === 0);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

// Chrome keeps the permissions the user accepted as granted_permissions
// ({api, explicit_host, scriptable_host}); API permissions with settings are
// objects keyed by name.
function acceptedIn(entry: Json): RequestedPermissions {
  const sets = [object(entry.granted_permissions), object(entry.active_permissions)];
  const api = sets.flatMap((set) =>
    Array.isArray(set.api) ? set.api.flatMap((item) => (typeof item === "string" ? [item] : Object.keys(object(item)))) : [],
  );
  return {
    api: [...new Set(api)],
    hosts: [...new Set(sets.flatMap((set) => strings(set.explicit_host)))],
    scriptableHosts: [...new Set(sets.flatMap((set) => strings(set.scriptable_host)))],
  };
}

function chromiumItems(profileDir: string): ImportItem[] {
  return chromiumEntries(profileDir).map((entry) => entry.item);
}

// Brave's importer reads the same prefs (brave-core chrome_importer_utils.cc):
// both files can hold extensions.settings, and Preferences wins.
function chromiumEntries(profileDir: string): ImportSource[] {
  const settings = {
    ...object(object(readJson(path.join(profileDir, "Secure Preferences"))?.extensions).settings),
    ...object(object(readJson(path.join(profileDir, "Preferences"))?.extensions).settings),
  };
  const items: ImportSource[] = [];
  for (const [id, value] of Object.entries(settings)) {
    const entry = object(value);
    const location = entry.location;
    if (!isExtensionId(id) || location === LOCATION_COMPONENT || location === LOCATION_EXTERNAL_COMPONENT) continue;
    if (entry.was_installed_by_default === true || typeof entry.path !== "string") continue;
    const dir = path.isAbsolute(entry.path) ? entry.path : path.join(profileDir, "Extensions", entry.path);
    const manifest = Object.keys(object(entry.manifest)).length > 0 ? object(entry.manifest) : readJson(path.join(dir, "manifest.json"));
    if (!manifest || typeof manifest.name !== "string") continue;
    if ("theme" in manifest || "app" in manifest) continue;
    const unpacked = location === LOCATION_UNPACKED || location === LOCATION_COMMAND_LINE;
    items.push({
      item: {
        id,
        name: directoryDisplayName(dir, manifest),
        enabled: chromiumEnabled(entry),
        icon: iconIn(dir, manifest.icons),
        status: unpacked ? "unavailable" : "ready",
        reason: unpacked ? "unpacked" : null,
      },
      accepted: acceptedIn(entry),
    });
  }
  return items;
}

function sortItems(items: ImportItem[]): ImportItem[] {
  const rank: Record<ImportStatus, number> = { ready: 0, installed: 1, unavailable: 2 };
  return items.sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
}

export interface FindImportsOptions {
  prodversion?: string;
  home?: string;
  // Whether to ask the Web Store which extensions it has, which sends their ids to Google.
  checkStore?: boolean;
}

// Every browser on this machine we can import extensions from, with each
// profile's extensions and whether we can install them from the Web Store.
function browserProfiles(location: BrowserLocation, home: string) {
  return browserRoots(location, home)
    .filter(isDirectory)
    .map(chromiumProfiles)
    .find((found) => found.length > 0);
}

// Re-reads one extension straight from the other browser's profile, so an
// import installs only what that profile really has.
export function findImportSource(browserKey: string, profileKey: string, id: string, home = os.homedir()): ImportSource | null {
  const location = BROWSERS.find((candidate) => candidate.key === browserKey);
  const profile = location ? browserProfiles(location, home)?.find((candidate) => candidate.key === profileKey) : undefined;
  return profile ? (chromiumEntries(profile.dir).find((entry) => entry.item.id === id) ?? null) : null;
}

export async function findImports(options: FindImportsOptions = {}): Promise<ImportBrowser[]> {
  const home = options.home ?? os.homedir();
  const browsers: ImportBrowser[] = [];
  for (const location of BROWSERS) {
    const profiles = browserProfiles(location, home);
    if (!profiles) continue;
    browsers.push({
      key: location.key,
      name: location.name,
      profiles: profiles.map((profile) => ({ key: profile.key, name: profile.name, items: chromiumItems(profile.dir) })),
    });
  }

  const candidates = browsers.flatMap((browser) => browser.profiles.flatMap((profile) => profile.items));
  const lookup = candidates.filter((item) => item.status === "ready" && !getExtension(item.id)).map((item) => item.id);
  const available = lookup.length > 0 && options.checkStore !== false ? await storeAvailability(lookup, options.prodversion ?? DEFAULT_PRODVERSION).catch(() => null) : new Set<string>();
  for (const item of candidates) {
    if (item.status !== "ready") continue;
    if (getExtension(item.id)) item.status = "installed";
    else if (available && !available.has(item.id)) {
      item.status = "unavailable";
      item.reason = "not_on_store";
    }
  }
  for (const browser of browsers) for (const profile of browser.profiles) sortItems(profile.items);
  return browsers;
}

export function importableItems(items: ImportItem[]): ImportItem[] {
  return items.filter((item) => item.status === "ready");
}

// Import skips the install prompt because the user accepted the extension in
// the other browser. If today's Web Store version asks for more than that, it
// waits for approval like an update would.
export function importDisabledReason(source: ImportSource, manifest: Record<string, unknown>): DisabledReason | null {
  if (permissionsIncreased(source.accepted, manifest)) return "permissions_increase";
  return source.item.enabled ? null : "user";
}
