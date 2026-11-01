import type { ExtensionService } from "../service";

// terminal-browser has no tab groups, so every tab is ungrouped and no group exists.
export function installTabGroups(service: ExtensionService) {
  const { router } = service;
  const permission = "tabGroups";
  const missing = (groupId: unknown) => {
    throw new Error(`No group with id: ${groupId}.`);
  };
  router.handle("tabGroups.query", () => [], { permission });
  router.handle("tabGroups.get", (_caller, groupId) => missing(groupId), { permission });
  router.handle("tabGroups.update", (_caller, groupId) => missing(groupId), { permission });
  router.handle("tabGroups.move", (_caller, groupId) => missing(groupId), { permission });
}
