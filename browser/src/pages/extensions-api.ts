import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { extensionsDeveloperMode, listExtensions, readManifestFile, setExtensionsDeveloperMode } from "shared";

import type { ExtensionSummary } from "../extensions/manage";
import { asManifest, manifestAction, pickIcon, resolveExtensionPath } from "../extensions/manifest";
import { extensionService } from "../extensions/service";
import type { InternalHandlers } from "./internal";
import { openFromPage } from "./open";

const ICON_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
};
const MAX_COMPLETIONS = 30;
const sizes = new Map<string, number>();

function iconDataUrl(summary: ExtensionSummary): string | null {
  let file = summary.icon;
  if (!file) {
    try {
      const manifest = asManifest(readManifestFile(summary.path));
      const relative = pickIcon(manifest.icons, 48) ?? pickIcon(manifestAction(manifest)?.default_icon, 48);
      file = relative ? resolveExtensionPath(summary.path, relative) : null;
    } catch {
      file = null;
    }
  }
  const type = file ? ICON_TYPES[path.extname(file).toLowerCase()] : undefined;
  if (!file || !type) return null;
  try {
    return `data:${type};base64,${fs.readFileSync(file).toString("base64")}`;
  } catch {
    return null;
  }
}

function directorySize(dir: string): number {
  let total = 0;
  const pending = [dir];
  while (pending.length) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(file).size;
        } catch {}
      }
    }
  }
  return total;
}

function cachedSize(summary: ExtensionSummary): number {
  const key = `${summary.path}@${summary.version}`;
  let size = sizes.get(key);
  if (size === undefined) {
    size = directorySize(summary.path);
    sizes.set(key, size);
  }
  return size;
}

function expandHome(input: string): string {
  return input === "~" || input.startsWith("~/") ? path.join(os.homedir(), input.slice(1)) : input;
}

function contractHome(file: string): string {
  const home = os.homedir();
  return file === home ? "~" : file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

function completePath(partial: string): string[] {
  const expanded = expandHome(partial || "~/");
  if (!path.isAbsolute(expanded)) return [];
  const endsWithSlash = expanded.endsWith(path.sep);
  const dir = endsWithSlash ? expanded : path.dirname(expanded);
  const prefix = endsWithSlash ? "" : path.basename(expanded);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.name.startsWith(prefix) && (prefix.startsWith(".") || !entry.name.startsWith(".")))
    .filter((entry) => entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(path.join(dir, entry.name), { throwIfNoEntry: false })?.isDirectory()))
    .map((entry) => `${contractHome(path.join(dir, entry.name))}/`)
    .sort()
    .slice(0, MAX_COMPLETIONS);
}

function asId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-p]{32}$/.test(value)) throw new Error("Invalid extension id");
  return value;
}

export function extensionsHandlers(): InternalHandlers["extensions"] {
  const service = extensionService();
  const { manager } = service;
  return {
    list: () => ({
      developerMode: extensionsDeveloperMode(),
      extensions: manager.summaries().map((summary) => ({
        ...summary,
        icon: iconDataUrl(summary),
        size: cachedSize(summary),
        path: contractHome(summary.path),
      })),
    }),
    setEnabled: (_sender, id, enabled) => manager.setEnabled(asId(id), enabled === true),
    remove: (_sender, id) => manager.remove(asId(id)),
    setPinned: (_sender, id, pinned) => manager.setPinned(asId(id), pinned === true),
    setUserScriptsAllowed: (_sender, id, allowed) => manager.setUserScriptsAllowed(asId(id), allowed === true),
    setShortcut: (_sender, id, command, shortcut) => {
      if (typeof command !== "string" || typeof shortcut !== "string") throw new Error("Invalid shortcut");
      manager.setShortcut(asId(id), command, shortcut);
    },
    loadUnpacked: async (_sender, dir) => {
      if (typeof dir !== "string" || !dir.trim()) throw new Error("Invalid path");
      const before = new Set(listExtensions().map((record) => record.id));
      try {
        const extension = await manager.loadUnpacked(expandHome(dir.trim()));
        return { id: extension.id, name: extension.name };
      } catch (error) {
        for (const record of listExtensions()) {
          if (!before.has(record.id)) await manager.remove(record.id).catch(() => {});
        }
        throw error;
      }
    },
    reload: (_sender, id) => manager.reload(asId(id)),
    update: async () => (await service.installer.checkForUpdates()).length,
    clearErrors: (_sender, id) => {
      service.errors.delete(asId(id));
      service.changed();
    },
    openUrl: (sender, url) => {
      if (typeof url !== "string") throw new Error("Invalid URL");
      const extensionId = /^chrome-extension:\/\/([a-p]{32})\//.exec(url)?.[1];
      const allowed = (extensionId && service.get(extensionId)) || url.startsWith("https://chromewebstore.google.com/");
      if (!allowed) throw new Error("Invalid URL");
      openFromPage(sender, url, true);
    },
    developerMode: () => extensionsDeveloperMode(),
    setDeveloperMode: (_sender, on) => setExtensionsDeveloperMode(on === true),
    completePath: (_sender, partial) => (typeof partial === "string" ? completePath(partial) : []),
  };
}
