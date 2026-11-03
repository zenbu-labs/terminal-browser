import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { WebContents } from "electron";
import { extensionsDeveloperMode, getExtension, listExtensions, readManifestFile, setExtensionsDeveloperMode } from "shared";

import type { ExtensionSummary } from "../extensions/manage";
import { asManifest, manifestAction, pickIcon, resolveExtensionPath } from "../extensions/manifest";
import { nextUserActivation } from "../extensions/user-activation";
import { extensionService } from "../extensions/service";
import { WEBSTORE_ORIGIN } from "../extensions/webstore";
import { canonicalUrl, extensionIdOfUrl } from "../canonical-url";
import type { InternalHandlers } from "./internal";
import { pageOpenedByBrowser } from "./opened-by";
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
const importsStarted = new WeakMap<WebContents, { browser: string; profile: string; ids: Set<string> }>();
const importPages = new WeakSet<WebContents>();

function startImport(contents: WebContents, browser: string, profile: string, ids: string[]) {
  if (!importPages.has(contents)) {
    importPages.add(contents);
    contents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) importsStarted.delete(contents);
    });
  }
  importsStarted.set(contents, { browser, profile, ids: new Set(ids) });
}

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
  return file ? fileDataUrl(file) : null;
}

function fileDataUrl(file: string): string | null {
  const type = ICON_TYPES[path.extname(file).toLowerCase()];
  if (!type) return null;
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
  const { manager, importer } = service;
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
    setEnabled: async (sender, id, enabled) => {
      const target = asId(id);
      if (enabled === true && getExtension(target)?.disabledReason === "permissions_increase") {
        return service.installer.approveNewPermissions(target, service.windowForContents(sender.id));
      }
      await manager.setEnabled(target, enabled === true);
      return true;
    },
    remove: (_sender, id) => manager.remove(asId(id)),
    setPinned: (_sender, id, pinned) => manager.setPinned(asId(id), pinned === true),
    setUserScriptsAllowed: (_sender, id, allowed) => manager.setUserScriptsAllowed(asId(id), allowed === true),
    setShortcut: (_sender, id, command, shortcut) => {
      if (typeof command !== "string" || typeof shortcut !== "string") throw new Error("Invalid shortcut");
      manager.setShortcut(asId(id), command, shortcut);
    },
    loadUnpacked: async (_sender, dir) => {
      if (typeof dir !== "string" || !dir.trim()) throw new Error("Invalid path");
      const folder = expandHome(dir.trim());
      if (!fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw new Error("Folder not found");
      if (!fs.existsSync(path.join(folder, "manifest.json"))) throw new Error("No manifest.json in this folder");
      const before = new Set(listExtensions().map((record) => record.id));
      try {
        const extension = await manager.loadUnpacked(folder);
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
    clearErrors: (_sender, id) => service.clearErrors(asId(id)),
    setErrorCollection: (_sender, id, on) => manager.setErrorCollection(asId(id), on === true),
    openUrl: (sender, url) => {
      if (typeof url !== "string") throw new Error("Invalid URL");
      const parsed = canonicalUrl(url);
      const extensionId = extensionIdOfUrl(url);
      const allowed = (extensionId && service.get(extensionId)) || parsed?.origin === WEBSTORE_ORIGIN;
      if (!parsed || !allowed) throw new Error("Invalid URL");
      openFromPage(sender, parsed.href, true);
    },
    developerMode: () => extensionsDeveloperMode(),
    setDeveloperMode: (_sender, on) => {
      setExtensionsDeveloperMode(on === true);
      if (on !== true) service.errors.clear();
      service.changed();
    },
    completePath: (_sender, partial) => (typeof partial === "string" ? completePath(partial) : []),
    // Other browsers' extension ids go to the Web Store, so a page the browser itself didn't open waits for the user first.
    importFind: async (sender) => {
      if (!pageOpenedByBrowser(sender) && !(await nextUserActivation(sender))) return [];
      const browsers = await importer.find();
      return browsers.map((browser) => ({
        ...browser,
        profiles: browser.profiles.map((profile) => ({
          ...profile,
          items: profile.items.map((item) => ({ ...item, icon: item.icon ? fileDataUrl(item.icon) : null })),
        })),
      }));
    },
    // The user's click on Import picks what importInstall may install.
    importStart: (sender, browser, profile, ids) => {
      // fixme: placeholder copy
      if (typeof browser !== "string" || typeof profile !== "string" || !Array.isArray(ids)) throw new Error("Invalid source");
      startImport(sender, browser, profile, ids.map(asId));
    },
    importInstall: (sender, browser, profile, id) => {
      const started = importsStarted.get(sender);
      if (!started || started.browser !== browser || started.profile !== profile || !started.ids.delete(asId(id))) throw new Error("Not allowed");
      return importer.install(started.browser, started.profile, asId(id));
    },
  };
}
