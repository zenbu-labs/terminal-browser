import fs from "node:fs";
import path from "node:path";

import {
  EXTENSIONS_DIR,
  deleteExtension,
  extensionIdForDirectory,
  getExtension,
  listExtensions,
  readManifestFile,
  saveExtension,
  updateExtension,
} from "shared";
import type { ExtensionRecord } from "shared";

import { extensionIcon } from "./action";
import { asManifest, optionalPermissions, optionsPage, permissionWarnings, requiredPermissions } from "./manifest";
import { setNativeUserScriptsAllowed } from "./native";
import type { LoadedExtension } from "./loaded";
import type { ExtensionService } from "./service";

export interface ExtensionSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  source: ExtensionRecord["source"];
  path: string;
  enabled: boolean;
  loaded: boolean;
  disabledReason: ExtensionRecord["disabledReason"];
  pinned: boolean;
  icon: string | null;
  optionsUrl: string | null;
  homepageUrl: string | null;
  permissions: string[];
  hosts: string[];
  warnings: string[];
  errors: string[];
  userScripts: { requested: boolean; allowed: boolean };
  commands: { name: string; description: string; shortcut: string }[];
}

export type InstallReason = "install" | "update";

// Everything that changes which extensions exist or run goes through here, so
// the daemon, the CLI and terminal-browser://extensions agree.
export class ExtensionManager {
  private readonly uninstallUrls = new Map<string, string>();

  constructor(private readonly service: ExtensionService) {}

  setUninstallUrl(id: string, url: string) {
    if (url) this.uninstallUrls.set(id, url);
    else this.uninstallUrls.delete(id);
  }

  summaries(): ExtensionSummary[] {
    return listExtensions().map((record) => this.summary(record));
  }

  summary(record: ExtensionRecord): ExtensionSummary {
    const loaded = this.service.get(record.id);
    let manifest = loaded?.manifest ?? null;
    if (!manifest) {
      try {
        manifest = asManifest(readManifestFile(record.path));
      } catch {
        manifest = null;
      }
    }
    const required = manifest ? requiredPermissions(manifest) : { api: [], hosts: [] };
    const options = manifest ? optionsPage(manifest) : null;
    return {
      id: record.id,
      name: loaded?.name ?? record.name,
      version: record.version,
      description: manifest?.description ?? "",
      source: record.source,
      path: record.path,
      enabled: record.enabled,
      loaded: loaded !== undefined && loaded !== null,
      disabledReason: record.disabledReason,
      pinned: record.pinned,
      icon: loaded ? extensionIcon(loaded, 48) : null,
      optionsUrl: options ? `chrome-extension://${record.id}/${options.replace(/^\//, "")}` : null,
      homepageUrl: manifest?.homepage_url ?? null,
      permissions: [...required.api, ...record.grantedPermissions],
      hosts: [...required.hosts, ...record.grantedOrigins],
      warnings: manifest ? permissionWarnings(required) : [],
      errors: this.service.errors.get(record.id) ?? [],
      userScripts: {
        requested: [...required.api, ...(manifest ? optionalPermissions(manifest).api : [])].includes("userScripts"),
        allowed: record.userScriptsAllowed,
      },
      commands: (manifest ? this.service.commands.list(manifest, record) : []).map((command) => ({
        ...command,
        description: command.description || (command.name === "_execute_action" ? "Activate the extension" : command.name),
      })),
    };
  }

  async loadUnpacked(dir: string): Promise<LoadedExtension> {
    const resolved = fs.realpathSync(path.resolve(dir));
    const manifest = readManifestFile(resolved);
    const id = extensionIdForDirectory(resolved, manifest);
    const existing = getExtension(id);
    const now = Date.now();
    const record: ExtensionRecord = {
      id,
      path: resolved,
      version: String(manifest.version ?? "0"),
      name: String(manifest.name ?? path.basename(resolved)),
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
    };
    saveExtension(record);
    return this.start(record, existing ? "update" : "install", existing?.version);
  }

  async start(record: ExtensionRecord, reason: InstallReason | null, previousVersion?: string): Promise<LoadedExtension> {
    const extension = await this.service.load(record);
    if (reason) {
      const details = reason === "update" ? { reason, previousVersion } : { reason };
      void this.service.events.dispatchWaking(extension.id, "runtime.onInstalled", [details]);
      this.service.broadcast("management.onInstalled", (other) =>
        other.hasApiPermission("management") ? [this.managementInfo(extension)] : null,
      );
    }
    return extension;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const record = updateExtension(id, { enabled, disabledReason: enabled ? null : "user" });
    if (!record) throw new Error(`No extension with id ${id}`);
    if (enabled) {
      const extension = await this.service.load(record);
      this.service.broadcast("management.onEnabled", (other) =>
        other.hasApiPermission("management") ? [this.managementInfo(extension)] : null,
      );
    } else {
      const extension = this.service.get(id);
      const info = extension ? this.managementInfo(extension) : null;
      await this.service.unload(id);
      if (info) {
        this.service.broadcast("management.onDisabled", (other) =>
          other.hasApiPermission("management") ? [{ ...info, enabled: false }] : null,
        );
      }
    }
  }

  async reload(id: string): Promise<void> {
    const record = getExtension(id);
    if (!record) throw new Error(`No extension with id ${id}`);
    if (!record.enabled) return;
    await this.service.load(record);
  }

  async remove(id: string): Promise<void> {
    const record = getExtension(id);
    if (!record) throw new Error(`No extension with id ${id}`);
    await this.service.unload(id);
    deleteExtension(id);
    const managed = path.resolve(EXTENSIONS_DIR, id);
    if (record.path.startsWith(`${managed}${path.sep}`)) fs.rmSync(managed, { recursive: true, force: true });
    try {
      await this.service.session.clearStorageData({ origin: `chrome-extension://${id}` });
    } catch {}
    this.service.broadcast("management.onUninstalled", (other) => (other.hasApiPermission("management") ? [id] : null));
    const uninstallUrl = this.uninstallUrls.get(id);
    this.uninstallUrls.delete(id);
    if (uninstallUrl) {
      const window = this.service.lastFocusedWindow();
      window?.host.tabs.create(uninstallUrl, true);
    }
    this.service.changed();
  }

  // Chrome gates chrome.userScripts behind a per-extension "Allow User Scripts" switch.
  setUserScriptsAllowed(id: string, allowed: boolean) {
    const record = updateExtension(id, { userScriptsAllowed: allowed });
    if (!record) throw new Error(`No extension with id ${id}`);
    const extension = this.service.get(id);
    if (extension) {
      extension.record = record;
      setNativeUserScriptsAllowed(this.service.session, id, allowed);
    }
    this.service.changed();
  }

  setPinned(id: string, pinned: boolean) {
    this.service.actions.setPinned(id, pinned);
  }

  setShortcut(id: string, command: string, shortcut: string) {
    const record = getExtension(id);
    if (!record) throw new Error(`No extension with id ${id}`);
    const shortcuts = { ...record.shortcuts, [command]: shortcut };
    const next = updateExtension(id, { shortcuts });
    const extension = this.service.get(id);
    if (extension && next) extension.record = next;
    this.service.changed();
  }

  managementInfo(extension: LoadedExtension): chrome.management.ExtensionInfo {
    const record = extension.record;
    const options = optionsPage(extension.manifest);
    return {
      id: extension.id,
      name: extension.name,
      shortName: extension.manifest.short_name ?? extension.name,
      description: extension.manifest.description ?? "",
      version: extension.manifest.version,
      versionName: extension.manifest.version_name,
      mayDisable: true,
      enabled: record.enabled,
      type: "extension",
      offlineEnabled: false,
      optionsUrl: options ? extension.url(options) : "",
      homepageUrl: extension.manifest.homepage_url,
      hostPermissions: extension.hosts,
      permissions: extension.apis,
      installType: record.source === "unpacked" ? "development" : "normal",
      isApp: false,
      icons: Object.entries(extension.manifest.icons ?? {}).map(([size, file]) => ({
        size: Number(size),
        url: extension.url(file),
      })),
    } as chrome.management.ExtensionInfo;
  }
}
