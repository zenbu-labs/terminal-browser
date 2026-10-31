import fs from "node:fs";
import path from "node:path";

import { app, session as electronSession } from "electron";
import type { Session, WebContents } from "electron";
import type { WebViewState } from "@zenbu-labs/pixel";

import { deleteExtension, getExtension, listExtensions, readManifestFile, saveExtension, updateExtension } from "shared";
import type { ExtensionRecord } from "shared";

import { browsing } from "../browsing";
import { isInternalUrl } from "../pages/internal";
import type { Tab } from "../session/tabs";
import { ActionStore } from "./action";
import { EventHub } from "./events";
import type { EventFilterMatch } from "./events";
import { ExtensionManager } from "./manage";
import { CommandStore } from "./commands";
import { MenuStore } from "./menus";
import { LoadedExtension } from "./loaded";
import { grantNativeActiveTab, revokeNativeActiveTab, setNativeUserScriptsAllowed } from "./native";
import { asManifest } from "./manifest";
import { Router } from "./router";
import { SenderTabs } from "./sender-tabs";
import { SidePanelStore } from "./side-panel";
import type { Caller } from "./router";
import type { ExtensionWindow, TabRef, WindowHost } from "./window";

export interface PopupWindowEntry {
  id: number;
  owner: ExtensionWindow;
  extensionId: string;
  contents: WebContents;
}

export type SurfaceKind = "action-popup" | "side-panel";

interface Surface {
  window: ExtensionWindow;
  kind: SurfaceKind;
  extensionId: string;
}

type ServiceListener = () => void;

export const WINDOW_ID_NONE = -1;
export const WINDOW_ID_CURRENT = -2;

let instance: ExtensionService | null = null;

function preloadPath(name = "extension-preload.js"): string {
  const candidates = [path.join(__dirname, name), path.join(__dirname, "..", name)];
  const found = candidates.find((file) => fs.existsSync(file));
  if (!found) throw new Error(`${name} missing (looked in ${candidates.join(", ")})`);
  return found;
}

export function extensionService(): ExtensionService {
  if (!instance) throw new Error("extension service has not started");
  return instance;
}

export function startExtensionService(target: Session = electronSession.defaultSession): ExtensionService {
  instance ??= new ExtensionService(target);
  return instance;
}

export class ExtensionService {
  readonly router: Router;
  readonly events: EventHub;
  readonly actions: ActionStore;
  readonly manager: ExtensionManager;
  readonly menus: MenuStore;
  readonly commands: CommandStore;
  readonly senderTabs: SenderTabs;
  readonly sidePanels: SidePanelStore;
  readonly loaded = new Map<string, LoadedExtension>();
  readonly errors = new Map<string, string[]>();
  private readonly windows = new Map<number, ExtensionWindow>();
  private readonly popupWindows = new Map<number, PopupWindowEntry>();
  private readonly surfaces = new Map<number, Surface>();
  private readonly listeners = new Set<ServiceListener>();
  private nextWindowId = 1;
  private lastFocusedWindowId: number | null = null;
  private readonly ready: Promise<void>;
  private readonly apiInstallers: ((service: ExtensionService) => void)[] = [];
  private readonly unloadListeners = new Set<(id: string) => void>();
  private readonly contentsListeners = new Set<(contents: WebContents, ref: TabRef) => void>();
  readonly debugging = new Map<number, Set<string>>();

  constructor(readonly session: Session) {
    this.router = new Router(session, (id) => this.loaded.get(id) ?? null);
    this.events = new EventHub(session, this.router, (id) => this.loaded.has(id));
    this.actions = new ActionStore(this);
    this.manager = new ExtensionManager(this);
    this.menus = new MenuStore(this);
    this.commands = new CommandStore(this);
    this.senderTabs = new SenderTabs(this);
    this.sidePanels = new SidePanelStore(this);
    const preload = preloadPath();
    session.registerPreloadScript({ type: "frame", filePath: preload });
    session.registerPreloadScript({ type: "service-worker", filePath: preload });
    this.ready = this.loadAll();
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  install(installer: (service: ExtensionService) => void) {
    this.apiInstallers.push(installer);
    installer(this);
  }

  onChange(listener: ServiceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onUnload(listener: (id: string) => void): () => void {
    this.unloadListeners.add(listener);
    return () => this.unloadListeners.delete(listener);
  }

  // Runs for every tab's web contents once the tab is ready.
  onTabContents(listener: (contents: WebContents, ref: TabRef) => void): () => void {
    this.contentsListeners.add(listener);
    return () => this.contentsListeners.delete(listener);
  }

  tabContentsReady(contents: WebContents, ref: TabRef) {
    for (const listener of [...this.contentsListeners]) listener(contents, ref);
  }

  changed() {
    for (const listener of [...this.listeners]) listener();
    for (const window of this.windows.values()) window.host.extensionsChanged();
  }

  private async loadAll() {
    await app.whenReady();
    for (const record of listExtensions()) {
      if (!record.enabled) continue;
      const extension = await this.load(record).catch(() => null);
      if (extension) this.events.dispatch(extension.id, "runtime.onStartup", []);
    }
    this.changed();
  }

  async load(record: ExtensionRecord): Promise<LoadedExtension> {
    if (this.loaded.has(record.id)) await this.unload(record.id);
    let electronExtension: Electron.Extension;
    try {
      readManifestFile(record.path);
      electronExtension = await this.session.extensions.loadExtension(record.path, { allowFileAccess: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.errors.set(record.id, [message]);
      throw error;
    }
    if (electronExtension.id !== record.id) {
      deleteExtension(record.id);
      record = { ...record, id: electronExtension.id };
      saveExtension(record);
    }
    const extension = new LoadedExtension(
      { ...record, name: electronExtension.name, version: electronExtension.version },
      asManifest(electronExtension.manifest),
      this.session,
    );
    await extension.refreshPermissions().catch(() => {});
    if (extension.manifest.permissions?.includes("userScripts")) {
      setNativeUserScriptsAllowed(this.session, extension.id, extension.record.userScriptsAllowed);
    }
    if (record.name !== electronExtension.name || record.version !== electronExtension.version) {
      updateExtension(record.id, { name: electronExtension.name, version: electronExtension.version });
    }
    this.loaded.set(extension.id, extension);
    this.errors.delete(extension.id);
    this.events.extensionLoaded(extension.id);
    this.actions.extensionLoaded(extension);
    this.changed();
    return extension;
  }

  async unload(id: string) {
    const extension = this.loaded.get(id);
    if (!extension) return;
    this.loaded.delete(id);
    for (const listener of [...this.unloadListeners]) listener(id);
    this.events.extensionUnloaded(id);
    this.actions.extensionUnloaded(id);
    this.sidePanels.extensionUnloaded(id);
    for (const window of this.windows.values()) window.host.closeActionPopup(id);
    for (const entry of [...this.popupWindows.values()]) {
      if (entry.extensionId === id) entry.owner.host.closePopupWindow(entry.id);
    }
    for (const { window, tab } of this.allTabs()) {
      if (tab.state.url.startsWith(extension.baseUrl)) window.host.closeTab(tab.id);
    }
    try {
      this.session.extensions.removeExtension(id);
    } catch {}
    this.changed();
  }

  async reconcile() {
    const records = listExtensions();
    const wanted = new Map(records.filter((record) => record.enabled).map((record) => [record.id, record]));
    for (const id of [...this.loaded.keys()]) {
      const record = wanted.get(id);
      if (!record) await this.unload(id);
    }
    for (const record of wanted.values()) {
      const current = this.loaded.get(record.id);
      if (!current || current.record.version !== record.version || current.path !== record.path) {
        await this.load(record).catch(() => {});
      } else {
        current.record = record;
        await current.refreshPermissions().catch(() => {});
      }
    }
    this.changed();
  }

  get(id: string): LoadedExtension | null {
    return this.loaded.get(id) ?? null;
  }

  record(id: string): ExtensionRecord | null {
    return getExtension(id);
  }

  addWindow(host: WindowHost): ExtensionWindow {
    const window: ExtensionWindow = { id: this.nextWindowId++, host };
    this.windows.set(window.id, window);
    if (this.lastFocusedWindowId === null || host.focused()) this.lastFocusedWindowId = window.id;
    host.tabs.observer = new TabEvents(this, window);
    this.broadcastWindow("windows.onCreated", window);
    return window;
  }

  removeWindow(window: ExtensionWindow) {
    if (!this.windows.delete(window.id)) return;
    this.sidePanels.windowRemoved(window);
    for (const entry of [...this.popupWindows.values()]) {
      if (entry.owner === window) this.removePopupWindow(entry.id);
    }
    for (const [contentsId, surface] of [...this.surfaces]) {
      if (surface.window === window) this.surfaces.delete(contentsId);
    }
    if (this.lastFocusedWindowId === window.id) this.lastFocusedWindowId = [...this.windows.keys()].pop() ?? null;
    this.broadcast("windows.onRemoved", () => [window.id]);
  }

  windowFocused(window: ExtensionWindow, focused: boolean) {
    if (!focused) {
      if (this.lastFocusedWindowId === window.id) this.broadcast("windows.onFocusChanged", () => [WINDOW_ID_NONE]);
      return;
    }
    if (this.lastFocusedWindowId === window.id) {
      this.broadcast("windows.onFocusChanged", () => [window.id]);
      return;
    }
    this.lastFocusedWindowId = window.id;
    this.broadcast("windows.onFocusChanged", () => [window.id]);
  }

  allWindows(): ExtensionWindow[] {
    return [...this.windows.values()];
  }

  window(id: number): ExtensionWindow | null {
    return this.windows.get(id) ?? null;
  }

  lastFocusedWindow(): ExtensionWindow | null {
    return (this.lastFocusedWindowId !== null && this.windows.get(this.lastFocusedWindowId)) || this.allWindows()[0] || null;
  }

  currentWindow(caller: Caller): ExtensionWindow | null {
    if (caller.kind === "frame") {
      const own = this.windowForContents(caller.contents.id);
      if (own) return own;
    }
    return this.lastFocusedWindow();
  }

  resolveWindowId(caller: Caller, windowId: unknown): ExtensionWindow | null {
    if (windowId === undefined || windowId === null || windowId === WINDOW_ID_CURRENT) return this.currentWindow(caller);
    if (typeof windowId !== "number") return null;
    return this.windows.get(windowId) ?? this.popupWindows.get(windowId)?.owner ?? null;
  }

  windowForContents(contentsId: number): ExtensionWindow | null {
    const tab = this.tabRef(contentsId);
    if (tab) return tab.window;
    const surface = this.surfaces.get(contentsId);
    if (surface) return surface.window;
    for (const entry of this.popupWindows.values()) {
      if (entry.contents.id === contentsId) return entry.owner;
    }
    return null;
  }

  registerSurface(contents: WebContents, window: ExtensionWindow, kind: SurfaceKind, extensionId: string) {
    this.surfaces.set(contents.id, { window, kind, extensionId });
    contents.once("destroyed", () => {
      if (this.surfaces.get(contents.id)?.window === window) this.surfaces.delete(contents.id);
    });
  }

  surface(contentsId: number): Surface | null {
    return this.surfaces.get(contentsId) ?? null;
  }

  reservePopupWindowId(): number {
    return this.nextWindowId++;
  }

  registerPopupWindow(entry: PopupWindowEntry) {
    this.popupWindows.set(entry.id, entry);
    entry.contents.once("destroyed", () => this.removePopupWindow(entry.id));
  }

  removePopupWindow(id: number) {
    if (!this.popupWindows.delete(id)) return;
    this.broadcast("windows.onRemoved", () => [id]);
  }

  popupWindow(id: number): PopupWindowEntry | null {
    return this.popupWindows.get(id) ?? null;
  }

  popupWindowForContents(contentsId: number): PopupWindowEntry | null {
    for (const entry of this.popupWindows.values()) if (entry.contents.id === contentsId) return entry;
    return null;
  }

  allPopupWindows(): PopupWindowEntry[] {
    return [...this.popupWindows.values()];
  }

  tabRef(contentsId: number): TabRef | null {
    for (const window of this.windows.values()) {
      const tab = window.host.tabs.byContentsId(contentsId);
      if (tab) return { window, tab };
    }
    return null;
  }

  allTabs(): TabRef[] {
    return this.allWindows().flatMap((window) =>
      window.host.tabs
        .all()
        .filter((tab) => tab.contentsId !== null)
        .map((tab) => ({ window, tab })),
    );
  }

  contentsOf(tab: Tab): WebContents | null {
    try {
      const contents = tab.ref.current?.webContents ?? null;
      return contents && !contents.isDestroyed() ? contents : null;
    } catch {
      return null;
    }
  }

  broadcast(event: string, argsFor: (extension: LoadedExtension) => unknown[] | null, match?: EventFilterMatch) {
    if (event.startsWith("tabs.") || event.startsWith("windows.")) this.senderTabs.changed();
    for (const extension of this.loaded.values()) {
      if (!this.events.hasListener(extension.id, event)) continue;
      const args = argsFor(extension);
      if (args) this.events.dispatch(extension.id, event, args, match);
    }
  }

  dispatch(extensionId: string, event: string, args: unknown[], match?: EventFilterMatch) {
    this.events.dispatch(extensionId, event, args, match);
  }

  private broadcastWindow(event: string, window: ExtensionWindow) {
    this.broadcast(event, () => [this.windowInfo(window, false)]);
  }

  windowInfo(window: ExtensionWindow, populate: boolean, extension?: LoadedExtension): chrome.windows.Window {
    const { width, height } = window.host.size();
    const info: chrome.windows.Window = {
      id: window.id,
      focused: window.id === this.lastFocusedWindowId && window.host.focused(),
      top: 0,
      left: 0,
      width,
      height,
      incognito: false,
      type: "normal",
      state: "normal",
      alwaysOnTop: false,
    };
    if (populate && extension) {
      info.tabs = window.host.tabs
        .all()
        .filter((tab) => tab.contentsId !== null)
        .map((tab) => this.tabInfo(extension, { window, tab }));
    }
    return info;
  }

  popupWindowInfo(entry: PopupWindowEntry, populate: boolean, extension?: LoadedExtension): chrome.windows.Window {
    const info: chrome.windows.Window = {
      id: entry.id,
      focused: false,
      top: 0,
      left: 0,
      width: 0,
      height: 0,
      incognito: false,
      type: "popup",
      state: "normal",
      alwaysOnTop: false,
    };
    if (populate && extension) info.tabs = [this.popupTabInfo(extension, entry)];
    return info;
  }

  tabInfo(extension: LoadedExtension, { window, tab }: TabRef): chrome.tabs.Tab {
    const tabs = window.host.tabs;
    const active = tabs.active === tab;
    const contents = this.contentsOf(tab);
    const url = tab.state.url;
    const info: chrome.tabs.Tab = {
      id: tab.contentsId ?? -1,
      index: tabs.all().indexOf(tab),
      windowId: window.id,
      active,
      highlighted: active,
      selected: active,
      pinned: false,
      audible: tab.state.audible,
      discarded: false,
      autoDiscardable: true,
      frozen: false,
      groupId: -1,
      incognito: false,
      mutedInfo: { muted: tab.state.muted },
      status: tab.state.loading ? "loading" : "complete",
      width: contents ? window.host.size().width : 0,
      height: contents ? window.host.size().height : 0,
      lastAccessed: tab.lastAccessed,
      url,
      title: tab.state.title || url,
      favIconUrl: this.favicons.get(tab.contentsId ?? -1),
    };
    const opener = tab.openerId !== null ? tabs.get(tab.openerId) : null;
    if (opener?.contentsId) info.openerTabId = opener.contentsId;
    return this.scrubTab(extension, info);
  }

  popupTabInfo(extension: LoadedExtension, entry: PopupWindowEntry): chrome.tabs.Tab {
    const contents = entry.contents;
    const url = contents.isDestroyed() ? "" : contents.getURL();
    return this.scrubTab(extension, {
      id: contents.id,
      index: 0,
      windowId: entry.id,
      active: true,
      highlighted: true,
      selected: true,
      pinned: false,
      discarded: false,
      autoDiscardable: true,
      frozen: false,
      groupId: -1,
      incognito: false,
      status: !contents.isDestroyed() && contents.isLoading() ? "loading" : "complete",
      url,
      title: contents.isDestroyed() ? "" : contents.getTitle(),
    });
  }

  scrubTab(extension: LoadedExtension, info: chrome.tabs.Tab): chrome.tabs.Tab {
    if (info.url !== undefined && extension.canSeeTab(info.id ?? -1, info.url)) return info;
    const { url: _url, pendingUrl: _pending, title: _title, favIconUrl: _favicon, ...rest } = info;
    return rest as chrome.tabs.Tab;
  }

  readonly favicons = new Map<number, string>();

  // Called for every user action aimed at an extension (icon click, shortcut, menu item).
  grantActiveTab(extension: LoadedExtension, tab: Tab) {
    extension.noteUserGesture();
    if (tab.contentsId === null || isInternalUrl(tab.state.url)) return;
    if (!extension.manifest.permissions?.includes("activeTab")) return;
    extension.grantActiveTab(tab.contentsId, tab.state.url);
    const contents = this.contentsOf(tab);
    if (contents) grantNativeActiveTab(this.session, extension.id, contents);
  }

  revokeActiveTab(extension: LoadedExtension, tab: Tab) {
    if (tab.contentsId === null) return;
    extension.revokeActiveTab(tab.contentsId);
    const contents = this.contentsOf(tab);
    if (contents) revokeNativeActiveTab(this.session, extension.id, contents);
  }
}

// Turns tab changes in one pane into chrome.tabs events for every extension.
class TabEvents {
  constructor(
    private readonly service: ExtensionService,
    private readonly window: ExtensionWindow,
  ) {}

  created() {}

  ready(tab: Tab) {
    const contents = this.service.contentsOf(tab);
    const ref = { window: this.window, tab };
    if (contents) {
      this.watchContents(contents, tab);
      this.service.tabContentsReady(contents, ref);
    }
    this.service.broadcast("tabs.onCreated", (extension) => [this.service.tabInfo(extension, ref)]);
    if (this.window.host.tabs.active === tab) {
      this.service.sidePanels.tabActivated(this.window);
      this.announceActivated(tab);
    }
  }

  updated(tab: Tab, previous: WebViewState) {
    const next = tab.state;
    const change: chrome.tabs.OnUpdatedInfo = {};
    if (next.loading !== previous.loading) change.status = next.loading ? "loading" : "complete";
    if (next.url !== previous.url) change.url = next.url;
    if (next.title !== previous.title) change.title = next.title;
    if (next.audible !== previous.audible) change.audible = next.audible;
    if (next.muted !== previous.muted) change.mutedInfo = { muted: next.muted };
    if (Object.keys(change).length === 0) return;
    if (change.url && tab.contentsId !== null) {
      for (const extension of this.service.loaded.values()) {
        if (!extension.hasActiveTab(tab.contentsId, next.url)) this.service.revokeActiveTab(extension, tab);
      }
    }
    this.service.actions.tabNavigated(tab, change.url !== undefined);
    const ref = { window: this.window, tab };
    this.service.broadcast("tabs.onUpdated", (extension) => {
      const info = this.service.tabInfo(extension, ref);
      const visible = { ...change };
      if (info.url === undefined) {
        delete visible.url;
        delete visible.title;
        delete visible.favIconUrl;
      }
      if (Object.keys(visible).length === 0) return null;
      return [info.id, visible, info];
    });
  }

  activated(tab: Tab) {
    this.service.sidePanels.tabActivated(this.window);
    if (tab.contentsId !== null) this.announceActivated(tab);
  }

  private announceActivated(tab: Tab) {
    const ids = { tabId: tab.contentsId!, windowId: this.window.id };
    this.service.broadcast("tabs.onActivated", () => [ids]);
    this.service.broadcast("tabs.onActiveChanged", () => [ids.tabId, { windowId: ids.windowId }]);
    this.service.broadcast("tabs.onSelectionChanged", () => [ids.tabId, { windowId: ids.windowId }]);
    this.service.broadcast("tabs.onHighlighted", () => [{ windowId: ids.windowId, tabIds: [ids.tabId] }]);
    this.service.broadcast("tabs.onHighlightChanged", () => [{ windowId: ids.windowId, tabIds: [ids.tabId] }]);
    this.service.actions.tabActivated(this.window);
  }

  moved(tab: Tab, from: number, to: number) {
    if (tab.contentsId === null) return;
    const info = { windowId: this.window.id, fromIndex: from, toIndex: to };
    this.service.broadcast("tabs.onMoved", () => [tab.contentsId, info]);
  }

  removed(tab: Tab) {
    if (tab.contentsId === null) return;
    const id = tab.contentsId;
    browsing().closed.add({
      windowId: this.window.id,
      index: this.window.host.tabs.count,
      url: tab.state.url,
      title: tab.state.title,
      favIconUrl: this.service.favicons.get(id),
    });
    this.service.favicons.delete(id);
    for (const extension of this.service.loaded.values()) extension.revokeActiveTab(id);
    this.service.actions.tabRemoved(id);
    this.service.sidePanels.tabRemoved(this.window, id);
    const info = { windowId: this.window.id, isWindowClosing: false };
    this.service.broadcast("tabs.onRemoved", () => [id, info]);
  }

  private watchContents(contents: WebContents, tab: Tab) {
    contents.on("page-favicon-updated", (_event, favicons) => {
      const url = favicons[0];
      if (!url || this.service.favicons.get(contents.id) === url) return;
      this.service.favicons.set(contents.id, url);
      const ref = { window: this.window, tab };
      this.service.broadcast("tabs.onUpdated", (extension) => {
        const info = this.service.tabInfo(extension, ref);
        if (info.favIconUrl === undefined) return null;
        return [info.id, { favIconUrl: url }, info];
      });
    });
    contents.on("zoom-changed", () => {
      const zoom = contents.getZoomFactor();
      this.service.broadcast("tabs.onZoomChange", () => [
        { tabId: contents.id, oldZoomFactor: zoom, newZoomFactor: zoom, zoomSettings: { mode: "automatic", scope: "per-origin" } },
      ]);
    });
  }
}
