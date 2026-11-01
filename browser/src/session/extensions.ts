import type { WebContents } from "electron";
import type { EngineKeyEvent, WebViewHandle } from "@zenbu-labs/pixel";

import { listStep } from "shared";

import { extensionService } from "../extensions/service";
import type { ExtensionService } from "../extensions/service";
import type { ToolbarAction } from "../extensions/action";
import { extensionIcon } from "../extensions/action";
import { optionsPage } from "../extensions/manifest";
import { SIDE_PANEL_PERMISSION } from "../extensions/side-panel";
import type { ExtensionPrompt, ExtensionWindow, PopupWindowRequest, WindowHost } from "../extensions/window";
import type { ExtensionMenuItem, MenuContext } from "../extensions/menus";
import type { ExtensionSidePanelView, ExtensionsView } from "../ui/extension-types";
import type { PageMenuItem } from "../ui/types";
import type { TabManager } from "./tabs";

export const EXTENSIONS_PAGE = "terminal-browser://extensions";

const ACTION_MENU = {
  pin: "Pin",
  unpin: "Unpin",
  options: "Options",
  manage: "Manage extension",
  openSidePanel: "Open side panel",
  closeSidePanel: "Close side panel",
  remove: "Remove",
  manageAll: "Manage extensions",
  importAll: "Import extensions…",
};

const MENU_ITEM = "ext:";
const ACTION_ITEM = "action:";
const RUN_ITEM = "run:";
const MANAGE_ITEM = "manage-extensions";
const IMPORT_ITEM = "import-extensions";

function toPageMenu(items: ExtensionMenuItem[]): PageMenuItem[] {
  return items.map((item) =>
    item.type === "separator"
      ? separator(`${MENU_ITEM}${item.key}`)
      : {
          id: `${MENU_ITEM}${item.key}`,
          label: item.title,
          enabled: item.enabled,
          shortcut: "",
          checked: item.type === "checkbox" || item.type === "radio" ? item.checked : undefined,
          children: item.children.length > 0 ? toPageMenu(item.children) : undefined,
        },
  );
}

function separator(id: string): PageMenuItem {
  return { id, label: "", enabled: false, shortcut: "", separator: true };
}

export interface ActionPopupState {
  extensionId: string;
  url: string;
  key: number;
}

export interface PopupWindowState extends PopupWindowRequest {
  key: number;
  resolve(contents: WebContents): void;
}

export interface PromptState extends ExtensionPrompt {
  resolve(accepted: boolean): void;
}

export interface PaneHooks {
  tabs: TabManager;
  focused(): boolean;
  size(): { width: number; height: number };
  resolveUrl(url: string): string;
  closeTab(id: number): void;
  activate(): void;
  blurPage(): void;
  openPage(url: string): void;
  toast(message: string): void;
  requestRender(): void;
  layoutChanged(): void;
}

// The extension UI owned by one pane: which popup, side panel, popup windows
// and prompts are open. Chrome draws them from this state.
export class PaneExtensions implements WindowHost {
  readonly window: ExtensionWindow;
  readonly service: ExtensionService;
  popup: ActionPopupState | null = null;
  popupWindows: PopupWindowState[] = [];
  prompts: PromptState[] = [];
  menuOpen = false;
  menuIndex = -1;
  private focusedPopupWindow: number | null = null;
  private readonly sidePanelViews = new Map<string, WebViewHandle>();
  private showingSidePanel: string | null = null;
  private pendingFocus: string | null = null;
  private seq = 1;

  constructor(private readonly hooks: PaneHooks) {
    this.service = extensionService();
    this.window = this.service.addWindow(this);
  }

  get tabs(): TabManager {
    return this.hooks.tabs;
  }

  focused(): boolean {
    return this.hooks.focused();
  }

  size() {
    return this.hooks.size();
  }

  resolveUrl(url: string): string {
    return this.hooks.resolveUrl(url);
  }

  closeTab(id: number) {
    this.hooks.closeTab(id);
  }

  activate() {
    this.hooks.activate();
  }

  toast(message: string) {
    this.hooks.toast(message);
  }

  toolbar(): ToolbarAction[] {
    return this.service.actions.toolbar(this.window).sort((a, b) => a.name.localeCompare(b.name));
  }

  private sidePanelList(): ExtensionSidePanelView[] {
    return this.service.sidePanels.view(this.window).panels.map((panel) => {
      const extension = this.service.get(panel.extensionId);
      return { ...panel, name: extension?.manifest.short_name || extension?.name || "" };
    });
  }

  // The side panel on screen right now, if any.
  get sidePanel(): ExtensionSidePanelView | null {
    const { showing } = this.service.sidePanels.view(this.window);
    return this.sidePanelList().find((panel) => panel.key === showing) ?? null;
  }

  view(scale: number, onToolbar: boolean): ExtensionsView | null {
    const actions = this.toolbar();
    const prompt = this.prompts[0];
    const sidePanels = this.sidePanelList();
    if (actions.length === 0 && !prompt && this.popupWindows.length === 0 && sidePanels.length === 0) return null;
    return {
      actions,
      menuOpen: this.menuOpen,
      menuIndex: this.menuIndex,
      popup: this.popup,
      popupWindows: this.popupWindows.map(({ windowId, key, url, width, height }) => ({ windowId, key, url, width, height })),
      sidePanel: this.sidePanel,
      sidePanels,
      prompt: prompt ? { kind: prompt.kind, name: prompt.name, icon: prompt.icon, warnings: prompt.warnings } : null,
      scale,
      onToolbar,
    };
  }

  extensionsChanged() {
    if (this.menuOpen && this.toolbar().length === 0) this.menuOpen = false;
    this.hooks.requestRender();
  }

  clickAction(extensionId: string) {
    if (this.popup?.extensionId === extensionId) {
      this.closeActionPopup();
      return;
    }
    this.menuOpen = false;
    this.runAction(extensionId);
    this.hooks.requestRender();
  }

  // What the toolbar icon and the extension's _execute_action shortcut do.
  runAction(extensionId: string) {
    this.service.actions.activate(this.window, extensionId);
  }

  setPinned(extensionId: string, pinned: boolean) {
    this.service.actions.setPinned(extensionId, pinned);
  }

  toggleMenu(open = !this.menuOpen) {
    if (open && this.toolbar().length === 0) return;
    this.menuOpen = open;
    this.menuIndex = -1;
    if (open) this.closeActionPopup();
    this.hooks.requestRender();
  }

  hoverMenu(index: number) {
    if (this.menuIndex === index) return;
    this.menuIndex = index;
    this.hooks.requestRender();
  }

  openManager(extensionId?: string) {
    this.menuOpen = false;
    this.hooks.openPage(extensionId ? `${EXTENSIONS_PAGE}/?id=${extensionId}` : EXTENSIONS_PAGE);
    this.hooks.requestRender();
  }

  openImporter() {
    this.menuOpen = false;
    this.hooks.openPage(`${EXTENSIONS_PAGE}/import`);
    this.hooks.requestRender();
  }

  optionsUrl(extensionId: string): string | null {
    const extension = this.service.get(extensionId);
    const page = extension ? optionsPage(extension.manifest) : null;
    return extension && page ? extension.url(page) : null;
  }

  openOptions(extensionId: string) {
    const url = this.optionsUrl(extensionId);
    if (url) this.hooks.openPage(url);
  }

  async remove(extensionId: string) {
    const extension = this.service.get(extensionId);
    if (!extension) return;
    const confirmed = await this.prompt({
      kind: "remove",
      extensionId,
      name: extension.name,
      icon: extensionIcon(extension, 48),
      warnings: [],
    });
    if (confirmed) await this.service.manager.remove(extensionId).catch((error: unknown) => this.toast(String(error)));
  }

  openActionPopup(extensionId: string, url: string) {
    this.menuOpen = false;
    this.popup = { extensionId, url, key: this.seq++ };
    this.hooks.blurPage();
    this.hooks.requestRender();
  }

  closeActionPopup(extensionId?: string) {
    if (!this.popup || (extensionId && this.popup.extensionId !== extensionId)) return;
    this.popup = null;
    this.hooks.activate();
    this.hooks.requestRender();
  }

  popupMounted(contents: WebContents) {
    if (!this.popup) return;
    this.service.registerSurface(contents, this.window, "action-popup", this.popup.extensionId);
  }

  openPopupWindow(request: PopupWindowRequest): Promise<WebContents> {
    return new Promise((resolve) => {
      this.popupWindows.push({ ...request, key: this.seq++, resolve });
      this.focusedPopupWindow = request.windowId;
      this.closeActionPopup();
      this.hooks.blurPage();
      this.hooks.requestRender();
    });
  }

  popupWindowMounted(windowId: number, contents: WebContents) {
    const entry = this.popupWindows.find((popup) => popup.windowId === windowId);
    entry?.resolve(contents);
  }

  focusPopupWindow(windowId: number | null) {
    this.focusedPopupWindow = windowId;
  }

  closePopupWindow(windowId: number) {
    const before = this.popupWindows.length;
    this.popupWindows = this.popupWindows.filter((popup) => popup.windowId !== windowId);
    if (this.popupWindows.length !== before) {
      this.service.removePopupWindow(windowId);
      if (this.focusedPopupWindow === windowId) {
        this.focusedPopupWindow = null;
        this.hooks.activate();
      }
      this.hooks.requestRender();
    }
  }

  sidePanelsChanged(focus: boolean) {
    const live = new Set(this.service.sidePanels.view(this.window).panels.map((panel) => panel.key));
    for (const key of [...this.sidePanelViews.keys()]) if (!live.has(key)) this.sidePanelViews.delete(key);
    const showing = this.sidePanel;
    const wasShowing = this.showingSidePanel;
    this.showingSidePanel = showing?.key ?? null;
    this.hooks.layoutChanged();
    if (focus && showing) this.focusSidePanel(showing.key);
    else if (wasShowing && !showing) this.hooks.activate();
    this.hooks.requestRender();
  }

  private focusSidePanel(key: string) {
    const view = this.sidePanelViews.get(key);
    this.menuOpen = false;
    this.closeActionPopup();
    if (view) view.focus();
    else this.pendingFocus = key;
  }

  sidePanelMounted(key: string, view: WebViewHandle) {
    this.sidePanelViews.set(key, view);
    this.service.sidePanels.mounted(this.window, key, view.webContents);
    if (this.pendingFocus === key) {
      this.pendingFocus = null;
      view.focus();
    }
  }

  closeSidePanel() {
    this.service.sidePanels.close(this.window);
  }

  // Chrome's "Open side panel" item in an extension's action menu.
  toggleSidePanel(extensionId: string) {
    const extension = this.service.get(extensionId);
    const tab = this.tabs.active;
    if (!extension || !tab) return;
    this.service.grantActiveTab(extension, tab);
    this.service.sidePanels.toggle(this.window, extension);
  }

  private hasSidePanel(extensionId: string): boolean {
    const extension = this.service.get(extensionId);
    if (!extension?.hasApiPermission(SIDE_PANEL_PERMISSION)) return false;
    return this.service.sidePanels.hasPanelForTab(extension, this.tabs.active?.contentsId ?? null);
  }

  prompt(request: ExtensionPrompt): Promise<boolean> {
    return new Promise((resolve) => {
      this.prompts.push({ ...request, resolve });
      this.menuOpen = false;
      this.closeActionPopup();
      this.hooks.blurPage();
      this.hooks.requestRender();
    });
  }

  answerPrompt(accepted: boolean) {
    const prompt = this.prompts.shift();
    prompt?.resolve(accepted);
    if (this.prompts.length === 0) this.hooks.activate();
    this.hooks.requestRender();
  }

  // Keys the extension UI takes before the page sees them; true means handled.
  handleKey(event: EngineKeyEvent): boolean {
    if (this.prompts.length > 0) {
      if (event.key === "escape") this.answerPrompt(false);
      else if (event.key === "enter") this.answerPrompt(true);
      return true;
    }
    if (this.menuOpen) {
      const count = this.toolbar().length + 1;
      const step = listStep(event);
      if (event.key === "escape") this.toggleMenu(false);
      else if (step) this.hoverMenu(this.menuIndex < 0 ? (step > 0 ? 0 : count - 1) : (this.menuIndex + step + count) % count);
      else if (event.key === "enter" && this.menuIndex >= 0) this.pickMenu(this.menuIndex);
      return true;
    }
    if (event.key !== "escape") return false;
    if (this.popup) {
      this.closeActionPopup();
      return true;
    }
    if (this.focusedPopupWindow !== null) {
      this.closePopupWindow(this.focusedPopupWindow);
      return true;
    }
    return false;
  }

  pickMenu(index: number) {
    const action = this.toolbar()[index];
    if (action) this.clickAction(action.extensionId);
    else this.openManager();
  }

  // chrome.contextMenus items for a right-click on the page.
  pageMenuItems(params: Electron.ContextMenuParams): PageMenuItem[] {
    return this.menuItems(params, "page");
  }

  private menuItems(params: Electron.ContextMenuParams | null, context: MenuContext, extensionId?: string): PageMenuItem[] {
    try {
      return toPageMenu(this.service.menus.items(this.window, params, context, extensionId));
    } catch {
      return [];
    }
  }

  // The menu for a right-click on an extension's toolbar icon.
  actionMenuItems(extensionId: string): PageMenuItem[] {
    const action = this.toolbar().find((entry) => entry.extensionId === extensionId);
    if (!action) return [];
    const own = this.menuItems(null, "action", extensionId);
    const item = (id: string, label: string): PageMenuItem => ({ id: `${ACTION_ITEM}${id}`, label, enabled: true, shortcut: "" });
    return [
      ...(own.length > 0 ? [...own, separator("action-separator")] : []),
      ...(this.hasSidePanel(extensionId)
        ? [
            this.service.sidePanels.showingExtension(this.window) === extensionId
              ? item("close-side-panel", ACTION_MENU.closeSidePanel)
              : item("open-side-panel", ACTION_MENU.openSidePanel),
          ]
        : []),
      item(action.pinned ? "unpin" : "pin", action.pinned ? ACTION_MENU.unpin : ACTION_MENU.pin),
      ...(this.optionsUrl(extensionId) ? [item("options", ACTION_MENU.options)] : []),
      item("manage", ACTION_MENU.manage),
      item("remove", ACTION_MENU.remove),
    ];
  }

  // The Extensions submenu of the … menu: what the toolbar icons do when they're hidden.
  toolbarMenuItems(): PageMenuItem[] {
    const extensions = this.toolbar().map(
      (action): PageMenuItem => ({
        id: `${RUN_ITEM}${action.extensionId}`,
        label: action.name,
        enabled: action.enabled,
        shortcut: "",
        icon: { src: action.icon, name: action.name },
        badge: action.badge ? { text: action.badge.text.slice(0, 4), color: action.badge.background } : undefined,
      }),
    );
    const actions = this.menuActions().map(({ id, label }): PageMenuItem => ({ id, label, enabled: true, shortcut: "" }));
    return [...extensions, ...(extensions.length > 0 ? [separator("extensions-actions-separator")] : []), ...actions];
  }

  // The plain rows under the extensions in the … menu's Extensions submenu.
  private menuActions(): { id: string; label: string; run(): void }[] {
    return [
      { id: MANAGE_ITEM, label: ACTION_MENU.manageAll, run: () => this.openManager() },
      { id: IMPORT_ITEM, label: ACTION_MENU.importAll, run: () => this.openImporter() },
    ];
  }

  // Runs an item from pageMenuItems, actionMenuItems or toolbarMenuItems; false when the id isn't ours.
  runMenuItem(id: string, params: Electron.ContextMenuParams | null, extensionId?: string): boolean {
    if (id.startsWith(RUN_ITEM)) {
      this.clickAction(id.slice(RUN_ITEM.length));
      return true;
    }
    const action = this.menuActions().find((entry) => entry.id === id);
    if (action) {
      action.run();
      return true;
    }
    if (id.startsWith(MENU_ITEM)) {
      this.service.menus.click(this.window, id.slice(MENU_ITEM.length), params);
      return true;
    }
    if (!id.startsWith(ACTION_ITEM) || !extensionId) return false;
    switch (id.slice(ACTION_ITEM.length)) {
      case "pin":
        this.setPinned(extensionId, true);
        break;
      case "unpin":
        this.setPinned(extensionId, false);
        break;
      case "open-side-panel":
      case "close-side-panel":
        this.toggleSidePanel(extensionId);
        break;
      case "options":
        this.openOptions(extensionId);
        break;
      case "manage":
        this.openManager(extensionId);
        break;
      case "remove":
        void this.remove(extensionId);
        break;
    }
    return true;
  }

  pagePointer() {
    this.focusedPopupWindow = null;
    if (this.popup) this.closeActionPopup();
  }

  tabActivated() {
    this.closeActionPopup();
  }

  focusChanged(focused: boolean) {
    this.service.windowFocused(this.window, focused);
  }

  dispose() {
    for (const prompt of this.prompts.splice(0)) prompt.resolve(false);
    for (const popup of this.popupWindows.splice(0)) this.service.removePopupWindow(popup.windowId);
    this.service.removeWindow(this.window);
  }
}
