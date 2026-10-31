import type { Caller } from "../router";
import { WINDOW_ID_CURRENT } from "../service";
import type { ExtensionService } from "../service";
import { extensionNavigableUrl } from "./tabs";

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
      const entry = { id, owner, extensionId: caller.extension.id, contents };
      service.registerPopupWindow(entry);
      const info = service.popupWindowInfo(entry, true, caller.extension);
      service.broadcast("windows.onCreated", () => [service.popupWindowInfo(entry, false)]);
      return info;
    }
    const opened = (urls.length > 0 ? urls : [owner.host.resolveUrl("")]).map((url, index) =>
      owner.host.tabs.create(url, (data.focused ?? true) && index === 0),
    );
    await Promise.all(opened.map((tab) => owner.host.tabs.whenReady(tab)));
    if (data.focused !== false) owner.host.activate();
    return service.windowInfo(owner, true, caller.extension);
  });

  router.handle("windows.update", (caller, windowId, updateInfo) => {
    if (typeof windowId !== "number") throw new Error(`No window with id: ${windowId}.`);
    const info = (updateInfo ?? {}) as chrome.windows.UpdateInfo;
    const window = service.window(windowId);
    if (window && info.focused) window.host.activate();
    return describe(caller, windowId, { populate: false });
  });

  router.handle("windows.remove", (_caller, windowId) => {
    if (typeof windowId !== "number") throw new Error(`No window with id: ${windowId}.`);
    const popup = service.popupWindow(windowId);
    if (popup) {
      popup.owner.host.closePopupWindow(popup.id);
      return;
    }
    if (!service.window(windowId)) throw new Error(`No window with id: ${windowId}.`);
    throw new Error("Extensions cannot close terminal-browser panes.");
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
