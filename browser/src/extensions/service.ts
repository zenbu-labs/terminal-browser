import fs from "node:fs";
import path from "node:path";

import { app, session as electronSession } from "electron";
import type { Session, WebContents } from "electron";
import type { WebViewState } from "@zenbu-labs/pixel";

import {
  deleteExtension,
  extensionErrorCollection,
  extensionsDeveloperMode,
  getExtension,
  listExtensions,
  readManifestFile,
  saveExtension,
  updateExtension,
} from "shared";
import type { ExtensionRecord } from "shared";

import { browsing } from "../browsing";
import { isInternalUrl } from "../pages/internal";
import type { Tab } from "../session/tabs";
import { ActionStore } from "./action";
import { EventHub } from "./events";
import type { EventFilterMatch } from "./events";
import { ExtensionManager } from "./manage";
import { CommandStore } from "./commands";
import { Importer } from "./import";
import { Installer } from "./install";
import { MenuStore } from "./menus";
import { LoadedExtension, allowsFileAccess } from "./loaded";
import { grantNativeActiveTab, revokeNativeActiveTab, setNativeUserScriptsAllowed, setNativeViewType } from "./native";
import { asManifest } from "./manifest";
import { Router } from "./router";
import { SenderTabs } from "./sender-tabs";
import { SidePanelStore } from "./side-panel";
import { TabStates } from "./tab-state";
import { OmniboxStore } from "./api/omnibox";
import { DeclarativeContentStore } from "./api/declarative-content";
import type { Caller } from "./router";
import type { ExtensionWindow, TabRef, WindowHost } from "./window";
import { onZoomLevelChanged, zoomSettings } from "./zoom";

export interface PopupWindowEntry {
  id: number;
  owner: ExtensionWindow;
  extensionId: string;
  contents: WebContents;
  tabId: number;
  url: string;
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
  readonly installer: Installer;
  readonly importer: Importer;
  readonly senderTabs: SenderTabs;
  readonly sidePanels: SidePanelStore;
  readonly omnibox: OmniboxStore;
  readonly declarativeContent: DeclarativeContentStore;
  readonly loaded = new Map<string, LoadedExtension>();
  readonly errors = new Map<string, string[]>();
  readonly loadErrors = new Map<string, string>();
  private readonly windows = new Map<number, ExtensionWindow>();
  private readonly popupWindows = new Map<number, PopupWindowEntry>();
  private readonly surfaces = new Map<number, Surface>();
  private readonly listeners = new Set<ServiceListener>();
  private nextWindowId = 1;
  private lastFocusedWindowId: number | null = null;
  private focusedWindowId: number | null = null;
  private readonly expectedPanes = new Map<string, (window: ExtensionWindow) => void>();
  private readonly panesFromExtensions = new Set<number>();
  private readonly ready: Promise<void>;
  private activated = false;
  private readonly activateListeners: (() => void)[] = [];
  private readonly unloadListeners = new Set<(id: string) => void>();
  private readonly contentsListeners = new Set<(contents: WebContents, ref: TabRef) => void>();
  private readonly readyContents = new Map<WebContents, TabRef>();
  readonly debugging = new Map<number, Set<string>>();
  readonly tabStates = new TabStates();
  private readonly tabEvents = new Map<number, TabEvents>();
  private readonly focusedPopups = new Map<number, number>();
  // Pages like chrome://newtab that an extension replaced keep reporting Chrome's URL.
  private readonly overriddenPages = new Map<number, { chromeUrl: string; url: string }>();

  constructor(readonly session: Session) {
    this.router = new Router(session, (id) => this.loaded.get(id) ?? null);
    this.events = new EventHub(session, this.router, (id) => this.loaded.has(id));
    this.actions = new ActionStore(this);
    this.manager = new ExtensionManager(this);
    this.menus = new MenuStore(this);
    this.commands = new CommandStore(this);
    this.installer = new Installer(this);
    this.importer = new Importer(this);
    this.senderTabs = new SenderTabs(this);
    this.sidePanels = new SidePanelStore(this);
    this.omnibox = new OmniboxStore(this);
    this.declarativeContent = new DeclarativeContentStore(this);
    session.registerPreloadScript({ type: "frame", filePath: preloadPath("chrome-web-store-preload.js") });
    this.ready = this.loadAll();
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  // Nothing extension-specific runs in pages or listens for IPC until the first
  // extension is installed, so people without extensions don't pay for it.
  onActivate(listener: () => void) {
    if (this.activated) listener();
    else this.activateListeners.push(listener);
  }

  activate() {
    if (this.activated) return;
    this.activated = true;
    const preload = preloadPath();
    this.session.registerPreloadScript({ type: "frame", filePath: preload });
    this.session.registerPreloadScript({ type: "service-worker", filePath: preload });
    this.router.listen();
    this.events.listen();
    for (const events of this.tabEvents.values()) events.trackOpenTabs();
    for (const listener of this.activateListeners.splice(0)) listener();
  }

  get active(): boolean {
    return this.activated;
  }

  onChange(listener: ServiceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onUnload(listener: (id: string) => void): () => void {
    this.unloadListeners.add(listener);
    return () => this.unloadListeners.delete(listener);
  }

  // Runs for every tab's web contents once the tab is ready, and right away for tabs that already are.
  onTabContents(listener: (contents: WebContents, ref: TabRef) => void): () => void {
    this.contentsListeners.add(listener);
    for (const [contents, ref] of [...this.readyContents]) {
      try {
        listener(contents, ref);
      } catch (error) {
        console.error(error);
      }
    }
    return () => this.contentsListeners.delete(listener);
  }

  tabContentsReady(contents: WebContents, ref: TabRef) {
    this.readyContents.set(contents, ref);
    contents.once("destroyed", () => this.readyContents.delete(contents));
    for (const listener of [...this.contentsListeners]) {
      try {
        listener(contents, ref);
      } catch (error) {
        console.error(error);
      }
    }
  }

  changed() {
    for (const listener of [...this.listeners]) listener();
    for (const window of this.windows.values()) window.host.extensionsChanged();
  }

  private async loadAll() {
    await app.whenReady();
    const records = listExtensions();
    if (records.length > 0) this.activate();
    for (const record of records) {
      if (!record.enabled) continue;
      const extension = await this.load(record).catch(() => null);
      if (extension) this.events.dispatch(extension.id, "runtime.onStartup", []);
    }
    this.changed();
  }

  async load(record: ExtensionRecord): Promise<LoadedExtension> {
    this.activate();
    if (this.loaded.has(record.id)) await this.unload(record.id);
    let electronExtension: Electron.Extension;
    try {
      readManifestFile(record.path);
      electronExtension = await this.session.extensions.loadExtension(record.path, { allowFileAccess: allowsFileAccess(record) });
    } catch (error) {
      this.loadErrors.set(record.id, error instanceof Error ? error.message : String(error));
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
    this.loadErrors.delete(extension.id);
    this.events.extensionLoaded(extension.id);
    this.actions.extensionLoaded(extension);
    this.changed();
    return extension;
  }

  // Like Chrome's error console: only in Developer mode, and then for unpacked
  // extensions unless turned off, for the rest only once turned on.
  collectsErrors(id: string): boolean {
    if (!extensionsDeveloperMode()) return false;
    return extensionErrorCollection(id) ?? getExtension(id)?.source === "unpacked";
  }

  // Failing to load is shown to everyone, what an extension logged only in Developer mode.
  visibleErrors(id: string): string[] {
    const failed = this.loadErrors.get(id);
    const logged = extensionsDeveloperMode() ? (this.errors.get(id) ?? []) : [];
    return failed === undefined ? logged : [failed, ...logged];
  }

  clearErrors(id: string) {
    this.errors.delete(id);
    this.loadErrors.delete(id);
    this.changed();
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

  addWindow(host: WindowHost, token: string | null = null): ExtensionWindow {
    const window: ExtensionWindow = { id: this.nextWindowId++, host };
    this.windows.set(window.id, window);
    const expected = token ? this.expectedPanes.get(token) : undefined;
    if (expected && token) {
      this.expectedPanes.delete(token);
      this.panesFromExtensions.add(window.id);
    }
    if (this.lastFocusedWindowId === null || host.focused()) this.lastFocusedWindowId = window.id;
    if (host.focused()) this.focusedWindowId = window.id;
    const events = new TabEvents(this, window);
    this.tabEvents.set(window.id, events);
    host.tabs.observer = events;
    this.broadcastWindow("windows.onCreated", window);
    expected?.(window);
    return window;
  }

  // windows.create opens a pane, whose browser then joins as a new window carrying `token`.
  expectPane(token: string, timeoutMs: number): Promise<ExtensionWindow | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.expectedPanes.delete(token);
        resolve(null);
      }, timeoutMs);
      this.expectedPanes.set(token, (window) => {
        clearTimeout(timer);
        resolve(window);
      });
    });
  }

  forgetPane(token: string) {
    this.expectedPanes.delete(token);
  }

  openedByExtension(window: ExtensionWindow): boolean {
    return this.panesFromExtensions.has(window.id);
  }

  removeWindow(window: ExtensionWindow) {
    if (!this.windows.has(window.id)) return;
    const events = this.tabEvents.get(window.id);
    for (const tab of [...window.host.tabs.all()]) events?.removed(tab, true);
    this.windows.delete(window.id);
    this.tabEvents.delete(window.id);
    this.panesFromExtensions.delete(window.id);
    if (this.focusedWindowId === window.id) this.focusedWindowId = null;
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
      if (this.focusedWindowId !== window.id) return;
      this.focusedWindowId = null;
      this.broadcast("windows.onFocusChanged", () => [WINDOW_ID_NONE]);
      return;
    }
    if (this.focusedWindowId === window.id) return;
    this.focusedWindowId = window.id;
    this.lastFocusedWindowId = window.id;
    this.broadcast("windows.onFocusChanged", () => [this.focusedPopups.get(window.id) ?? window.id]);
  }

  popupWindowFocused(window: ExtensionWindow, popupId: number | null) {
    if ((this.focusedPopups.get(window.id) ?? null) === popupId) return;
    if (popupId === null) this.focusedPopups.delete(window.id);
    else this.focusedPopups.set(window.id, popupId);
    if (this.lastFocusedWindowId === window.id && window.host.focused()) {
      this.broadcast("windows.onFocusChanged", () => [popupId ?? window.id]);
    }
  }

  windowBoundsChanged(window: ExtensionWindow) {
    this.broadcastWindow("windows.onBoundsChanged", window);
  }

  popupWindowBoundsChanged(id: number) {
    const entry = this.popupWindows.get(id);
    if (entry) this.broadcast("windows.onBoundsChanged", () => [this.popupWindowInfo(entry, false)]);
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
    setNativeViewType(this.session, contents, kind === "side-panel" ? "sidePanel" : "popup");
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
    const entry = this.popupWindows.get(id);
    if (!entry) return;
    this.popupWindows.delete(id);
    if (this.focusedPopups.get(entry.owner.id) === id) this.focusedPopups.delete(entry.owner.id);
    this.broadcast("tabs.onRemoved", () => [entry.tabId, { windowId: id, isWindowClosing: true }]);
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
      focused: window.id === this.lastFocusedWindowId && window.host.focused() && !this.focusedPopups.has(window.id),
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
    const bounds = entry.owner.host.popupWindowBounds(entry.id);
    const info: chrome.windows.Window = {
      id: entry.id,
      focused: this.focusedPopups.get(entry.owner.id) === entry.id && entry.owner.id === this.lastFocusedWindowId && entry.owner.host.focused(),
      top: 0,
      left: 0,
      width: bounds?.width ?? 0,
      height: bounds?.height ?? 0,
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
    const extras = tab.contentsId !== null ? this.tabStates.peek(tab.contentsId) : null;
    const committed = extras && !extras.committed ? "" : tab.state.url;
    const pending = extras?.pendingUrl;
    const url = this.chromeUrlFor(tab.contentsId, committed);
    const pendingUrl = pending && pending !== committed ? this.chromeUrlFor(tab.contentsId, pending) : undefined;
    const info: chrome.tabs.Tab = {
      id: tab.contentsId ?? -1,
      index: tabs.all().indexOf(tab),
      windowId: window.id,
      active,
      highlighted: active,
      selected: active,
      pinned: tab.pinned,
      audible: tab.state.audible,
      discarded: extras?.discarded ?? false,
      autoDiscardable: extras?.autoDiscardable ?? true,
      frozen: false,
      groupId: -1,
      ...NOT_SPLIT,
      incognito: false,
      mutedInfo: { muted: tab.state.muted, ...extras?.muted } as chrome.tabs.MutedInfo,
      status: extras?.discarded ? "unloaded" : tab.state.loading ? "loading" : "complete",
      width: contents ? window.host.size().width : 0,
      height: contents ? window.host.size().height : 0,
      lastAccessed: tab.lastAccessed,
      url,
      title: tab.state.title || url || pendingUrl || "",
    };
    if (pendingUrl) info.pendingUrl = pendingUrl;
    if (extras?.favIconUrl) info.favIconUrl = extras.favIconUrl;
    const opener = tab.openerId !== null ? tabs.get(tab.openerId) : null;
    if (opener?.contentsId) info.openerTabId = opener.contentsId;
    return this.scrubTab(extension, info);
  }

  overridePage(contentsId: number, chromeUrl: string, url: string) {
    this.overriddenPages.set(contentsId, { chromeUrl, url });
  }

  whenCommitted(tab: Tab): Promise<void> {
    const contents = this.contentsOf(tab);
    if (!contents || tab.contentsId === null || this.tabStates.peek(tab.contentsId)?.committed) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        contents.off("did-navigate", done);
        contents.off("did-stop-loading", done);
        contents.off("destroyed", done);
        resolve();
      };
      contents.on("did-navigate", done);
      contents.on("did-stop-loading", done);
      contents.once("destroyed", done);
    });
  }

  tabGone(contentsId: number) {
    this.tabStates.delete(contentsId);
    this.overriddenPages.delete(contentsId);
  }

  private chromeUrlFor(contentsId: number | null, url: string): string {
    const overridden = contentsId !== null ? this.overriddenPages.get(contentsId) : undefined;
    return overridden?.url === url ? overridden.chromeUrl : url;
  }

  reloadDiscarded({ tab }: TabRef) {
    const extras = tab.contentsId !== null ? this.tabStates.peek(tab.contentsId) : null;
    if (!extras?.discarded) return;
    extras.discarded = false;
    this.contentsOf(tab)?.reload();
  }

  tabChanged({ window, tab }: TabRef, change: chrome.tabs.OnUpdatedInfo) {
    this.tabEvents.get(window.id)?.announce(tab, change);
  }

  popupTabInfo(extension: LoadedExtension, entry: PopupWindowEntry): chrome.tabs.Tab {
    const contents = entry.contents;
    const url = contents.isDestroyed() ? "" : contents.getURL();
    const pending = !url || (!contents.isDestroyed() && contents.isLoading() && url !== entry.url);
    return this.scrubTab(extension, {
      ...(pending ? { pendingUrl: entry.url } : {}),
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
      ...NOT_SPLIT,
      incognito: false,
      status: !contents.isDestroyed() && contents.isLoading() ? "loading" : "complete",
      url,
      title: contents.isDestroyed() ? "" : contents.getTitle(),
    });
  }

  scrubTab(extension: LoadedExtension, info: chrome.tabs.Tab): chrome.tabs.Tab {
    const url = info.url || info.pendingUrl;
    if (url !== undefined && extension.canSeeTab(info.id ?? -1, url)) return info;
    const { url: _url, pendingUrl: _pending, title: _title, favIconUrl: _favicon, ...rest } = info;
    return rest as chrome.tabs.Tab;
  }

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

// Chrome's tabs also say which split view they're in (missing from @types/chrome); terminal-browser has none.
const NOT_SPLIT: object = { splitViewId: -1 };

// WebContents.getURL() already shows a navigation that hasn't committed yet; the frame doesn't.
function committedUrl(contents: WebContents): string {
  try {
    return contents.mainFrame.url;
  } catch {
    return "";
  }
}

function canonicalUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

// Turns tab changes in one pane into chrome.tabs events for every extension.
class TabEvents {
  private readonly tracked = new WeakSet<WebContents>();

  constructor(
    private readonly service: ExtensionService,
    private readonly window: ExtensionWindow,
  ) {}

  created() {}

  ready(tab: Tab) {
    if (!this.service.active) return;
    const ref = { window: this.window, tab };
    this.track(tab);
    this.service.broadcast("tabs.onCreated", (extension) => [this.service.tabInfo(extension, ref)]);
    if (this.window.host.tabs.active === tab) {
      this.service.sidePanels.tabActivated(this.window);
      this.announceActivated(tab);
    }
  }

  // Tabs are only watched once an extension is installed; the ones open by then start being watched here.
  trackOpenTabs() {
    for (const tab of this.window.host.tabs.all()) this.track(tab);
  }

  private track(tab: Tab) {
    const contents = this.service.contentsOf(tab);
    if (!contents || this.tracked.has(contents)) return;
    this.tracked.add(contents);
    const extras = this.service.tabStates.get(contents.id);
    const committed = committedUrl(contents);
    extras.reportedUrl = committed;
    extras.committed = committed !== "";
    extras.pendingUrl = committed ? null : canonicalUrl(tab.url);
    this.watchContents(contents, tab);
    this.service.tabContentsReady(contents, { window: this.window, tab });
  }

  updated(tab: Tab, previous: WebViewState) {
    if (tab.contentsId === null || !this.service.active) return;
    const next = tab.state;
    const extras = this.service.tabStates.get(tab.contentsId);
    const change: chrome.tabs.OnUpdatedInfo = {};
    if (next.loading !== previous.loading) change.status = next.loading ? "loading" : "complete";
    const shownUrl = next.loading && extras.pendingUrl ? extras.pendingUrl : next.url;
    if (shownUrl !== extras.reportedUrl && (change.status === "loading" || next.url !== previous.url)) {
      change.url = shownUrl;
      extras.reportedUrl = shownUrl;
    }
    if (next.audible !== previous.audible) change.audible = next.audible;
    if (next.muted !== previous.muted) {
      const requested = extras.requestedMute?.muted === next.muted ? extras.requestedMute : null;
      extras.muted = requested ? { reason: requested.reason, extensionId: requested.extensionId } : { reason: "user" };
      change.mutedInfo = { muted: next.muted, ...extras.muted } as chrome.tabs.MutedInfo;
      extras.requestedMute = null;
    }
    if (next.favicon !== previous.favicon) {
      const url = next.favicon ? extras.faviconCandidates[0] : undefined;
      if (url !== extras.favIconUrl) {
        extras.favIconUrl = url;
        if (url) change.favIconUrl = url;
      }
    }
    if (Object.keys(change).length === 0) return;
    if (change.url) {
      for (const extension of this.service.loaded.values()) {
        if (!extension.hasActiveTab(tab.contentsId, next.url)) this.service.revokeActiveTab(extension, tab);
      }
    }
    this.service.actions.tabNavigated(tab, change.url !== undefined);
    this.announceUpdate(tab, change);
  }

  private announceUpdate(tab: Tab, change: chrome.tabs.OnUpdatedInfo) {
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

  announce(tab: Tab, change: chrome.tabs.OnUpdatedInfo) {
    if (tab.contentsId !== null) this.announceUpdate(tab, change);
  }

  activated(tab: Tab) {
    this.service.sidePanels.tabActivated(this.window);
    if (tab.contentsId !== null) {
      this.service.reloadDiscarded({ window: this.window, tab });
      this.announceActivated(tab);
    }
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

  pinned(tab: Tab) {
    this.announce(tab, { pinned: tab.pinned });
  }

  removed(tab: Tab, isWindowClosing = false) {
    if (tab.contentsId === null) return;
    const id = tab.contentsId;
    const extras = this.service.tabStates.get(id);
    // Like Chrome, a tab closed before its first page committed isn't recently closed.
    if (extras.committed) {
      browsing().closed.add({
        windowId: this.window.id,
        index: this.window.host.tabs.count,
        url: tab.state.url,
        title: tab.state.title,
        favIconUrl: extras.favIconUrl,
        lastAccessed: tab.lastAccessed,
      });
    }
    this.service.tabGone(id);
    for (const extension of this.service.loaded.values()) extension.revokeActiveTab(id);
    this.service.actions.tabRemoved(id);
    this.service.sidePanels.tabRemoved(this.window, id);
    const info = { windowId: this.window.id, isWindowClosing };
    this.service.broadcast("tabs.onRemoved", () => [id, info]);
  }

  private watchContents(contents: WebContents, tab: Tab) {
    const extras = () => this.service.tabStates.peek(contents.id);
    // Runs before the pane's own listener, so the pending URL is known when loading starts.
    contents.prependListener("did-start-navigation", (details) => {
      const state = extras();
      if (state && details.isMainFrame && !details.isSameDocument) state.pendingUrl = details.url;
    });
    const settled = () => {
      const state = extras();
      if (state) state.pendingUrl = null;
    };
    contents.prependListener("did-navigate", () => {
      const state = extras();
      if (state) state.committed = true;
      settled();
    });
    contents.on("did-fail-load", (_event, _code, _description, _url, isMainFrame) => {
      if (isMainFrame) settled();
    });
    contents.prependListener("did-stop-loading", () => {
      const state = extras();
      if (state) state.committed = true;
      settled();
    });
    contents.on("page-favicon-updated", (_event, favicons) => {
      const state = extras();
      if (state) state.faviconCandidates = favicons;
    });
    contents.on("page-title-updated", (_event, title) => {
      if (extras()) this.announce(tab, { title: title || tab.state.url });
    });
    onZoomLevelChanged(contents, ({ oldZoomFactor, newZoomFactor }) => {
      // A zoom mode change reports the level before the new mode is in place, so the settings are read after it.
      queueMicrotask(() => {
        if (!extras() || contents.isDestroyed()) return;
        const change = { tabId: contents.id, oldZoomFactor, newZoomFactor, zoomSettings: zoomSettings(contents) };
        this.service.broadcast("tabs.onZoomChange", () => [change]);
      });
    });
  }
}
