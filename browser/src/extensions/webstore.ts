import { ipcMain } from "electron";
import type { IpcMainInvokeEvent, WebContents } from "electron";

import { CrxError, ManifestError, getExtension, isExtensionId, listExtensions } from "shared";
import type { ExtensionPackage, ExtensionRecord } from "shared";

import { AlreadyInstalledError, InstallInProgressError } from "./install";
import type { ExtensionService } from "./service";
import type { TabRef } from "./window";

export const WEBSTORE_ORIGIN = "https://chromewebstore.google.com";

type Handler = (ref: TabRef, contents: WebContents, ...args: unknown[]) => unknown;

interface BeginResult {
  result: string;
  error?: string;
}

// Chrome's own error strings (extensions/browser/api/webstore_private/webstore_private_api.cc).
const ALREADY_INSTALLED = "This item is already installed";
const USER_CANCELLED = "User cancelled install";
const INVALID_ID = "Invalid id";
const NO_BEGIN = "* does not match a previous call to beginInstallWithManifest3";

// Answers the Chrome Web Store page's chrome.webstorePrivate and
// chrome.management calls. Only the store's own top frame, in one of our tabs,
// gets an answer, and nothing installs without our prompt being accepted.
export class WebStore {
  private readonly approved = new Map<string, ExtensionPackage>();
  private lastState = new Map<string, boolean>();

  constructor(private readonly service: ExtensionService) {
    this.handle("begin-install", (ref, contents, details) => this.beginInstall(ref, contents, details));
    this.handle("complete-install", (_ref, contents, id) => this.completeInstall(contents, id));
    this.handle("install", (ref, _contents, id) => this.legacyInstall(ref, id));
    this.handle("extension-status", (_ref, _contents, id, manifest) => this.status(id, manifest));
    this.handle("management-get-all", () => listExtensions().map((record) => this.info(record)));
    this.handle("management-get", (_ref, _contents, id) => this.get(id));
    this.handle("management-set-enabled", (ref, _contents, id, enabled) => this.setEnabled(ref, id, enabled === true));
    this.handle("management-uninstall", (ref, _contents, id) => this.uninstall(ref, id));
    this.lastState = this.snapshot();
    service.onChange(() => this.announceChanges());
  }

  private handle(method: string, run: Handler) {
    ipcMain.handle(`tb-webstore:${method}`, (event, ...args) => {
      const ref = this.storeTab(event);
      if (!ref) throw new Error(`chrome.webstorePrivate is not available here`);
      return run(ref, event.sender, ...args);
    });
  }

  private storeTab(event: IpcMainInvokeEvent): TabRef | null {
    const frame = event.senderFrame;
    if (!frame || frame.parent !== null || frame.origin !== WEBSTORE_ORIGIN) return null;
    if (event.sender.session !== this.service.session || event.sender.mainFrame !== frame) return null;
    return this.service.tabRef(event.sender.id);
  }

  private async beginInstall(ref: TabRef, contents: WebContents, details: unknown): Promise<BeginResult> {
    const id = typeof details === "object" && details !== null ? (details as { id?: unknown }).id : undefined;
    if (typeof id !== "string" || !isExtensionId(id)) return { result: "invalid_id", error: INVALID_ID };
    if (getExtension(id)) return { result: "already_installed", error: ALREADY_INSTALLED };
    try {
      const pkg = await this.service.installer.prepareFromStore(id, ref.window);
      if (!pkg) return { result: "user_cancelled", error: USER_CANCELLED };
      this.approved.set(`${contents.id}:${id}`, pkg);
      return { result: "" };
    } catch (error) {
      return failure(error);
    }
  }

  private async completeInstall(contents: WebContents, id: unknown): Promise<void> {
    if (typeof id !== "string" || !isExtensionId(id)) throw new Error(INVALID_ID);
    const key = `${contents.id}:${id}`;
    const pkg = this.approved.get(key);
    if (!pkg) throw new Error(NO_BEGIN.replace("*", id));
    this.approved.delete(key);
    await this.service.installer.commit(pkg);
  }

  private async legacyInstall(ref: TabRef, id: unknown): Promise<void> {
    if (typeof id !== "string" || !isExtensionId(id)) throw new Error(INVALID_ID);
    const result = await this.service.installer.installFromStore(id, ref.window);
    if (!result) throw new Error(USER_CANCELLED);
  }

  private status(id: unknown, manifest: unknown): string {
    if (typeof id !== "string" || !isExtensionId(id)) throw new Error(INVALID_ID);
    const record = getExtension(id);
    if (record) {
      if (!record.enabled) return "disabled";
      return this.service.errors.has(id) && !this.service.get(id) ? "corrupted" : "enabled";
    }
    if (this.service.installer.isInstalling(id)) return "installable";
    if (typeof manifest === "string" && manifest) {
      try {
        if ((JSON.parse(manifest) as { manifest_version?: unknown }).manifest_version === 2) return "deprecated_manifest_version";
      } catch {}
    }
    return "installable";
  }

  private get(id: unknown) {
    const record = typeof id === "string" ? getExtension(id) : null;
    // Chrome's chrome.management error text.
    if (!record) throw new Error(`Failed to find extension with id ${String(id)}.`);
    return this.info(record);
  }

  private async setEnabled(ref: TabRef, id: unknown, enabled: boolean) {
    const record = typeof id === "string" ? getExtension(id) : null;
    if (!record) throw new Error(`Failed to find extension with id ${String(id)}.`);
    if (enabled && record.disabledReason === "permissions_increase") {
      const summary = this.service.manager.summary(record);
      const accepted = await ref.window.host.prompt({
        kind: "update",
        extensionId: record.id,
        name: summary.name,
        icon: summary.icon,
        warnings: summary.warnings,
      });
      if (!accepted) throw new Error(USER_CANCELLED);
      return this.service.installer.acceptNewPermissions(record.id);
    }
    await this.service.manager.setEnabled(record.id, enabled);
  }

  private async uninstall(ref: TabRef, id: unknown) {
    const record = typeof id === "string" ? getExtension(id) : null;
    if (!record) throw new Error(`Failed to find extension with id ${String(id)}.`);
    const summary = this.service.manager.summary(record);
    const accepted = await ref.window.host.prompt({
      kind: "remove",
      extensionId: record.id,
      name: summary.name,
      icon: summary.icon,
      warnings: [],
    });
    // Chrome's chrome.management error text.
    if (!accepted) throw new Error(`Extension ${record.id} uninstall canceled by user.`);
    if (getExtension(record.id)) await this.service.manager.remove(record.id);
  }

  private info(record: ExtensionRecord): chrome.management.ExtensionInfo {
    const loaded = this.service.get(record.id);
    if (loaded) return { ...this.service.manager.managementInfo(loaded), enabled: record.enabled };
    const summary = this.service.manager.summary(record);
    return {
      id: record.id,
      name: summary.name,
      shortName: summary.name,
      description: summary.description,
      version: record.version,
      mayDisable: true,
      enabled: record.enabled,
      disabledReason: record.disabledReason === "permissions_increase" ? "permissions_increase" : "unknown",
      type: "extension",
      offlineEnabled: false,
      optionsUrl: summary.optionsUrl ?? "",
      homepageUrl: summary.homepageUrl ?? undefined,
      hostPermissions: summary.hosts,
      permissions: summary.permissions,
      installType: record.source === "webstore" ? "normal" : "development",
      isApp: false,
      icons: [],
    } as chrome.management.ExtensionInfo;
  }

  private snapshot(): Map<string, boolean> {
    return new Map(listExtensions().map((record) => [record.id, record.enabled]));
  }

  private storeContents(): WebContents[] {
    return this.service
      .allTabs()
      .map(({ tab }) => this.service.contentsOf(tab))
      .filter((contents): contents is WebContents => {
        if (!contents) return false;
        try {
          return new URL(contents.getURL()).origin === WEBSTORE_ORIGIN;
        } catch {
          return false;
        }
      });
  }

  // The store page keeps its buttons in sync through chrome.management events.
  private announceChanges() {
    const next = this.snapshot();
    const previous = this.lastState;
    this.lastState = next;
    const events: [string, unknown[]][] = [];
    for (const [id, enabled] of next) {
      const record = getExtension(id);
      if (!record) continue;
      if (!previous.has(id)) events.push(["management.onInstalled", [this.info(record)]]);
      else if (previous.get(id) !== enabled) {
        events.push([enabled ? "management.onEnabled" : "management.onDisabled", [this.info(record)]]);
      }
    }
    for (const id of previous.keys()) if (!next.has(id)) events.push(["management.onUninstalled", [id]]);
    if (events.length === 0) return;
    for (const contents of this.storeContents()) {
      for (const [name, args] of events) contents.mainFrame.send("tb-webstore:event", name, args);
    }
  }
}

function failure(error: unknown): BeginResult {
  if (error instanceof AlreadyInstalledError) return { result: "already_installed", error: ALREADY_INSTALLED };
  if (error instanceof InstallInProgressError) return { result: "install_in_progress", error: error.message };
  if (error instanceof ManifestError) return { result: "manifest_error", error: error.message };
  if (error instanceof CrxError) {
    if (error.code === "not_found" || error.code === "wrong_id") return { result: "invalid_id", error: error.message };
    return { result: "install_error", error: error.message };
  }
  return { result: "unknown_error", error: error instanceof Error ? error.message : String(error) };
}
