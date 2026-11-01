import { hasUserGesture } from "../router";
import type { Caller } from "../router";
import type { ExtensionService } from "../service";
import { SIDE_PANEL_PERMISSION as permission } from "../side-panel";
import type { ExtensionWindow } from "../window";

export function installSidePanel(service: ExtensionService) {
  const { router, sidePanels } = service;

  service.actions.clickHandlers.push((window, extension, tab) => {
    if (!extension.hasApiPermission(permission) || !sidePanels.opensOnActionClick(extension.id)) return false;
    if (!sidePanels.hasPanelForTab(extension, tab.contentsId)) return false;
    sidePanels.toggle(window, extension);
    return true;
  });

  // open() resolves windowId before looking at tabId; close() only compares it.
  const target = (caller: Caller, value: unknown, windowFirst: boolean) => {
    const { tabId, windowId } = (value ?? {}) as { tabId?: number; windowId?: number };
    if (tabId === undefined && windowId === undefined) throw new Error("At least one of `tabId` and `windowId` must be provided");
    const resolveWindow = () => {
      const window = service.resolveWindowId(caller, windowId);
      if (!window) throw new Error(`No window with id: ${windowId}.`);
      return window;
    };
    let window: ExtensionWindow | null = windowId !== undefined && (windowFirst || tabId === undefined) ? resolveWindow() : null;
    if (tabId === undefined) return { window: window!, tabId: null };
    const ref = service.tabRef(tabId);
    if (!ref) throw new Error(`No tab with id: ${tabId}.`);
    if (windowId !== undefined) window ??= service.resolveWindowId(caller, windowId);
    if (windowId !== undefined && ref.window !== window) throw new Error("The specified tab does not belong to the specified window.");
    return { window: ref.window, tabId };
  };

  router.handle(
    "sidePanel.setOptions",
    (caller, value) => {
      const { tabId, path, enabled } = (value ?? {}) as { tabId?: number; path?: string; enabled?: boolean };
      sidePanels.setOptions(caller.extension, tabId ?? null, { path, enabled });
    },
    { permission },
  );

  router.handle(
    "sidePanel.getOptions",
    (caller, value) => {
      const { tabId } = (value ?? {}) as { tabId?: number };
      return sidePanels.getOptions(caller.extension, tabId ?? null);
    },
    { permission },
  );

  router.handle(
    "sidePanel.setPanelBehavior",
    (caller, value) => {
      const { openPanelOnActionClick } = (value ?? {}) as { openPanelOnActionClick?: boolean };
      if (openPanelOnActionClick !== undefined) sidePanels.setOpensOnActionClick(caller.extension.id, openPanelOnActionClick);
    },
    { permission },
  );

  router.handle(
    "sidePanel.getPanelBehavior",
    (caller) => ({ openPanelOnActionClick: sidePanels.opensOnActionClick(caller.extension.id) }),
    { permission },
  );

  router.handle(
    "sidePanel.open",
    (caller, value) => {
      if (!hasUserGesture(caller)) throw new Error("`sidePanel.open()` may only be called in response to a user gesture.");
      const { window, tabId } = target(caller, value, true);
      if (tabId !== null) sidePanels.openForTab(window, caller.extension, tabId);
      else sidePanels.openForWindow(window, caller.extension);
    },
    { permission },
  );

  router.handle(
    "sidePanel.close",
    (caller, value) => {
      const { window, tabId } = target(caller, value, false);
      if (tabId !== null) sidePanels.closeForTab(window, caller.extension, tabId);
      else sidePanels.closeForWindow(window, caller.extension);
    },
    { permission },
  );

  router.handle("sidePanel.getLayout", () => ({ side: "right" }), { permission });
}
