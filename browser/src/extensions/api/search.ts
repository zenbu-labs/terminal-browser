import { ConfigStore, SETTINGS, SETTINGS_FILE, SHORTCUTS_FILE } from "shared";

import { searchUrlFor } from "../../url";
import type { ExtensionService } from "../service";

export function configuredSearchEngine(): string {
  return new ConfigStore({ settings: SETTINGS_FILE, shortcuts: SHORTCUTS_FILE }).load().settings?.["search.engine"] ??
    SETTINGS["search.engine"].default;
}

export function installSearch(service: ExtensionService) {
  service.router.handle(
    "search.query",
    async (caller, queryInfo) => {
      const { text, disposition, tabId } = (queryInfo ?? {}) as chrome.search.QueryInfo;
      if (typeof text !== "string" || !text) throw new Error("Text must not be empty.");
      if (disposition !== undefined && tabId !== undefined) throw new Error("Cannot set both 'disposition' and 'tabId'.");
      const url = searchUrlFor(configuredSearchEngine())(text);
      if (tabId !== undefined) {
        const ref = service.tabRef(tabId);
        if (!ref) throw new Error(`No tab with id: ${tabId}.`);
        ref.tab.ref.current?.loadURL(url);
        return;
      }
      const window = service.currentWindow(caller);
      if (!window) throw new Error("No current window.");
      const active = window.host.tabs.active;
      if ((disposition ?? "CURRENT_TAB") === "CURRENT_TAB" && active) {
        active.ref.current?.loadURL(url);
        return;
      }
      window.host.tabs.create(url, true);
    },
    { permission: "search" },
  );
}
