import { getExtension, listExtensions, updateExtension } from "shared";

import { extensionService } from "./service";

export interface ExtensionCommand {
  cmd: "extensions";
  action: string;
  id?: string;
  dir?: string;
  previousVersion?: string;
}

function requireId(message: ExtensionCommand): string {
  if (!message.id || !getExtension(message.id)) throw new Error(`no extension with id ${message.id ?? ""}`);
  return message.id;
}

// `terminal-browser extensions ...` sends these over the daemon socket so a
// running browser applies changes at once (and fires onInstalled and friends).
// Installs are prompted for and unpacked by the CLI before it says "installed".
export async function extensionCommand(message: ExtensionCommand): Promise<unknown> {
  const service = extensionService();
  await service.whenReady();
  switch (message.action) {
    case "list":
      return service.manager.summaries();
    case "reconcile":
      await service.reconcile();
      return null;
    case "installed": {
      const record = getExtension(requireId(message));
      if (!record?.enabled) return null;
      await service.manager.start(record, message.previousVersion ? "update" : "install", message.previousVersion);
      return null;
    }
    case "load": {
      if (!message.dir) throw new Error("load needs a directory");
      const extension = await service.manager.loadUnpacked(message.dir);
      return { id: extension.id, name: extension.name, version: extension.manifest.version };
    }
    case "reload": {
      const ids = message.id
        ? [requireId(message)]
        : listExtensions()
            .filter((record) => record.source === "unpacked" && record.enabled)
            .map((record) => record.id);
      const failed: Record<string, string[]> = {};
      for (const id of ids) {
        await service.manager.reload(id).catch(() => {});
        const errors = service.errors.get(id);
        if (!service.get(id) && errors) failed[id] = errors;
      }
      return { reloaded: ids, failed };
    }
    case "remove":
      await service.manager.remove(requireId(message));
      return null;
    case "enable": {
      const id = requireId(message);
      if (getExtension(id)?.disabledReason === "permissions_increase") await service.installer.acceptNewPermissions(id);
      else await service.manager.setEnabled(id, true);
      return null;
    }
    case "disable":
      await service.manager.setEnabled(requireId(message), false);
      return null;
    case "pin":
    case "unpin": {
      const id = requireId(message);
      const pinned = message.action === "pin";
      if (service.get(id)) service.manager.setPinned(id, pinned);
      else if (updateExtension(id, { pinned })) service.changed();
      return null;
    }
    case "update":
      if (message.id) requireId(message);
      return service.installer.update(message.id, false);
    default:
      throw new Error(`unknown extensions action ${message.action}`);
  }
}
