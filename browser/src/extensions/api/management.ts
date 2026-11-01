import { getExtension, listExtensions, readManifestFile } from "shared";
import type { ExtensionRecord } from "shared";

import { extensionIcon } from "../action";
import { LoadedExtension } from "../loaded";
import { asManifest, permissionWarnings, requiredPermissions } from "../manifest";
import type { Manifest } from "../manifest";
import { hasUserGesture } from "../router";
import type { Caller } from "../router";
import type { ExtensionService } from "../service";

const permission = "management";

function noExtension(id: unknown): Error {
  return new Error(`Failed to find extension with id ${id}.`);
}

export function installManagement(service: ExtensionService) {
  const { router, manager } = service;

  const describe = (record: ExtensionRecord): chrome.management.ExtensionInfo | null => {
    const loaded = service.get(record.id);
    if (loaded) return manager.managementInfo(loaded);
    let manifest: Manifest;
    try {
      manifest = asManifest(readManifestFile(record.path));
    } catch {
      return null;
    }
    const info = manager.managementInfo(new LoadedExtension(record, manifest, service.session));
    return {
      ...info,
      enabled: false,
      disabledReason: record.disabledReason === "permissions_increase" ? "permissions_increase" : "unknown",
    } as chrome.management.ExtensionInfo;
  };

  const find = (id: unknown): ExtensionRecord => {
    const record = typeof id === "string" ? getExtension(id) : null;
    if (!record) throw noExtension(id);
    return record;
  };

  const warningsFor = (manifest: Manifest) => permissionWarnings(requiredPermissions(manifest));

  const confirmUninstall = async (caller: Caller, record: ExtensionRecord) => {
    const window = service.currentWindow(caller);
    if (!window) return false;
    const target = service.get(record.id);
    return window.host.prompt({
      kind: "remove",
      extensionId: record.id,
      name: target?.name ?? record.name,
      icon: target ? extensionIcon(target, 48) : null,
      warnings: [],
    });
  };

  // Removing an extension unloads it, which may be the caller itself, so the
  // reply goes out first.
  const removeSoon = (id: string) => {
    setTimeout(() => void manager.remove(id).catch(() => {}), 0);
  };

  router.handle("management.getAll", () => listExtensions().map(describe).filter((info) => info !== null), { permission });
  router.handle("management.get", (_caller, id) => describe(find(id)), { permission });
  router.handle("management.getSelf", (caller) => describe(caller.extension.record));
  router.handle("management.getPermissionWarningsById", (_caller, id) => {
    const record = find(id);
    const loaded = service.get(record.id);
    return warningsFor(loaded?.manifest ?? asManifest(readManifestFile(record.path)));
  }, { permission });
  router.handle("management.getPermissionWarningsByManifest", (_caller, manifestText) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(manifestText));
    } catch {
      throw new Error("Failed to parse manifest.");
    }
    const manifest = parsed as Partial<Manifest> | null;
    if (!manifest || typeof manifest !== "object" || !manifest.name || !manifest.version) {
      throw new Error("Failed to create extension from manifest.");
    }
    return warningsFor({ manifest_version: 2, ...manifest } as Manifest);
  });

  router.handle(
    "management.setEnabled",
    async (caller, id, enabled) => {
      const record = find(id);
      if (enabled && record.disabledReason === "permissions_increase") {
        if (!hasUserGesture(caller)) {
          throw new Error("Re-enabling an extension disabled due to permissions increase requires a user gesture.");
        }
        const window = service.currentWindow(caller);
        const manifest = asManifest(readManifestFile(record.path));
        const accepted = window
          ? await window.host.prompt({ kind: "permissions", extensionId: record.id, name: record.name, icon: null, warnings: warningsFor(manifest) })
          : false;
        if (!accepted) throw new Error("The user did not accept the re-enable dialog.");
      }
      if (record.enabled === Boolean(enabled)) return;
      if (!enabled && record.id === caller.extension.id) {
        setTimeout(() => void manager.setEnabled(record.id, false).catch(() => {}), 0);
        return;
      }
      await manager.setEnabled(record.id, Boolean(enabled));
    },
    { permission },
  );

  router.handle(
    "management.uninstall",
    async (caller, id, options) => {
      const record = find(id);
      const self = record.id === caller.extension.id;
      const confirm = (options as { showConfirmDialog?: boolean } | undefined)?.showConfirmDialog ?? false;
      if (!self && !hasUserGesture(caller)) throw new Error("chrome.management.uninstall requires a user gesture.");
      if ((!self || confirm) && !(await confirmUninstall(caller, record))) {
        throw new Error(`Extension ${record.id} uninstall canceled by user.`);
      }
      removeSoon(record.id);
    },
    { permission },
  );

  router.handle("management.uninstallSelf", async (caller, options) => {
    const record = caller.extension.record;
    const confirm = (options as { showConfirmDialog?: boolean } | undefined)?.showConfirmDialog ?? false;
    if (confirm && !(await confirmUninstall(caller, record))) throw new Error(`Extension ${record.id} uninstall canceled by user.`);
    removeSoon(record.id);
  });

  router.handle(
    "management.launchApp",
    (_caller, id) => {
      const record = find(id);
      throw new Error(`Extension ${record.id} is not an App.`);
    },
    { permission },
  );

  const appOnly = (gestureError: string) => (caller: Caller, id: unknown) => {
    if (!hasUserGesture(caller)) throw new Error(gestureError);
    const record = find(id);
    throw new Error(`Extension ${record.id} is not an App.`);
  };
  router.handle("management.createAppShortcut", appOnly("chrome.management.createAppShortcut requires a user gesture."), { permission });
  router.handle("management.setLaunchType", appOnly("chrome.management.setLaunchType requires a user gesture."), { permission });
  router.handle(
    "management.generateAppForLink",
    (caller) => {
      if (!hasUserGesture(caller)) throw new Error("chrome.management.generateAppForLink requires a user gesture.");
      throw new Error("chrome.management.generateAppForLink is not supported on this platform.");
    },
    { permission },
  );
}
