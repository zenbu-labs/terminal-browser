import { randomUUID } from "node:crypto";

import type { Caller } from "../router";
import { WINDOW_ID_CURRENT } from "../service";
import type { ExtensionService } from "../service";
import { extensionNavigableUrl } from "./tabs";
import type { ExtensionWindow } from "../window";

const PANE_JOIN_MS = 20_000;

interface GetInfo {
  populate?: boolean;
  windowTypes?: string[];
}

export function installWindows(service: ExtensionService) {
  const { router } = service;

  const describe = (caller: Caller, windowId: number, getInfo: GetInfo | undefined) => {
    const populate = getInfo?.populate ?? false;
    const types = getInfo?.windowTypes;
    const popup = service.popupWindow(windowId);
    if (popup) {
      if (types && !types.includes("popup")) throw new Error(`No window with id: ${windowId}.`);
      return service.popupWindowInfo(popup, populate, caller.extension);
    }
    const window = service.window(windowId);
    if (!window) throw new Error(`No window with id: ${windowId}.`);
    return service.windowInfo(window, populate, caller.extension);
  };

  router.handle("windows.get", (caller, windowId, getInfo) => {
    const id = windowId === WINDOW_ID_CURRENT ? service.currentWindow(caller)?.id : windowId;
    if (typeof id !== "number") throw new Error(`No window with id: ${windowId}.`);
    return describe(caller, id, getInfo as GetInfo);
  });

  router.handle("windows.getCurrent", (caller, getInfo) => {
    if (caller.kind === "frame") {
      const popup = service.popupWindowForContents(caller.contents.id);
      if (popup) return describe(caller, popup.id, getInfo as GetInfo);
    }
    const window = service.currentWindow(caller);
    if (!window) throw new Error("No current window.");
    return describe(caller, window.id, getInfo as GetInfo);
  });

  router.handle("windows.getLastFocused", (caller, getInfo) => {
    const window = service.lastFocusedWindow();
    if (!window) throw new Error("No last-focused window.");
    return describe(caller, window.id, getInfo as GetInfo);
  });

  router.handle("windows.getAll", (caller, getInfo) => {
    const info = (getInfo ?? {}) as GetInfo;
    const types = info.windowTypes ?? ["normal", "popup"];
    const windows: chrome.windows.Window[] = [];
    if (types.includes("normal")) {
      for (const window of service.allWindows()) windows.push(service.windowInfo(window, info.populate ?? false, caller.extension));
    }
    if (types.includes("popup")) {
      for (const entry of service.allPopupWindows()) windows.push(service.popupWindowInfo(entry, info.populate ?? false, caller.extension));
    }
    return windows;
  });

  // Like `terminal-browser open --split`: the terminal opens a pane whose browser joins as the new window.
  const openPane = async (owner: ExtensionWindow, urls: string[], focused: boolean): Promise<ExtensionWindow | null> => {
    const token = randomUUID();
    const joined = service.expectPane(token, PANE_JOIN_MS);
    const opened = await owner.host.openPane({ url: urls[0] ?? null, token, focused }).catch(() => false);
    if (!opened) {
      service.forgetPane(token);
      return null;
    }
    const window = await joined;
    // fixme: placeholder copy
    if (!window) throw new Error("The new window did not open.");
    for (const url of urls.slice(1)) window.host.tabs.create(url, false);
    await Promise.all(window.host.tabs.all().map((tab) => window.host.tabs.whenReady(tab)));
    return window;
  };

  router.handle("windows.create", async (caller, createData) => {
    const data = (createData ?? {}) as chrome.windows.CreateData;
    const owner = service.lastFocusedWindow();
    if (!owner) throw new Error("No window to open in.");
    const urls = (Array.isArray(data.url) ? data.url : data.url ? [data.url] : []).map((url) =>
      extensionNavigableUrl(service, caller.extension, url),
    );
    if (data.tabId !== undefined) throw new Error("Moving tabs between windows is not supported.");
    if (data.type === "popup" || data.type === "panel") {
      const id = service.reservePopupWindowId();
      const contents = await owner.host.openPopupWindow({
        windowId: id,
        extensionId: caller.extension.id,
        url: urls[0] ?? "about:blank",
        width: data.width ?? null,
        height: data.height ?? null,
      });
      const url = urls[0] ?? "about:blank";
      const entry = { id, owner, extensionId: caller.extension.id, contents, tabId: contents.id, url };
      service.registerPopupWindow(entry);
      service.broadcast("windows.onCreated", () => [service.popupWindowInfo(entry, false)]);
      service.broadcast("tabs.onCreated", (extension) => [service.popupTabInfo(extension, entry)]);
      if (data.focused !== false) owner.host.updatePopupWindow(id, { focused: true });
      return service.popupWindowInfo(entry, true, caller.extension);
    }
    const pane = await openPane(owner, urls, data.focused !== false);
    if (pane) return service.windowInfo(pane, true, caller.extension);
    const opened = (urls.length > 0 ? urls : [owner.host.resolveUrl("")]).map((url, index) =>
      owner.host.tabs.create(url, (data.focused ?? true) && index === 0),
    );
    await Promise.all(opened.map((tab) => owner.host.tabs.whenReady(tab)));
    if (data.focused !== false) owner.host.activate();
    return service.windowInfo(owner, true, caller.extension);
  });

  router.handle("windows.update", async (caller, windowId, updateInfo) => {
    if (typeof windowId !== "number") throw new Error(`No window with id: ${windowId}.`);
    const info = (updateInfo ?? {}) as chrome.windows.UpdateInfo;
    const popup = service.popupWindow(windowId);
    const window = service.window(windowId);
    if (!popup && !window) throw new Error(`No window with id: ${windowId}.`);
    // A pane's size, position and state belong to the terminal, so like Chrome with a
    // window it can't move, those requests leave the pane as it is.
    if (popup) {
      const size = (value: number | undefined) => (typeof value === "number" && value > 0 ? Math.round(value) : undefined);
      popup.owner.host.updatePopupWindow(popup.id, {
        width: size(info.width),
        height: size(info.height),
        focused: info.focused === true,
      });
    } else if (window && info.focused) {
      window.host.activate();
      await window.host.focusPane();
    }
    return describe(caller, windowId, { populate: false });
  });

  router.handle("windows.remove", (_caller, windowId) => {
    if (typeof windowId !== "number") throw new Error(`No window with id: ${windowId}.`);
    const popup = service.popupWindow(windowId);
    if (popup) {
      popup.owner.host.closePopupWindow(popup.id);
      return;
    }
    const window = service.window(windowId);
    if (!window) throw new Error(`No window with id: ${windowId}.`);
    // Only panes opened by windows.create; the user's own panes stay theirs.
    if (!service.openedByExtension(window)) throw new Error("Extensions cannot close terminal-browser panes.");
    window.host.closePane();
  });

  router.handle("windows.closeSelf", (caller) => {
    if (caller.kind !== "frame") return;
    const contentsId = caller.contents.id;
    const popup = service.popupWindowForContents(contentsId);
    if (popup) {
      popup.owner.host.closePopupWindow(popup.id);
      return;
    }
    const surface = service.surface(contentsId);
    if (surface?.kind === "action-popup") {
      surface.window.host.closeActionPopup(surface.extensionId);
      return;
    }
    if (surface?.kind === "side-panel") {
      service.sidePanels.closeSelf(caller.contents);
      return;
    }
    const ref = service.tabRef(contentsId);
    if (ref && caller.frame === caller.contents.mainFrame) ref.window.host.closeTab(ref.tab.id);
  });
}
