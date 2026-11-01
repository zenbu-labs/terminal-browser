import type { WebContents } from "electron";

import { opensSidePanelOnActionClick, setOpensSidePanelOnActionClick } from "shared";

import type { LoadedExtension } from "./loaded";
import type { ExtensionService } from "./service";
import type { ExtensionWindow } from "./window";

export const SIDE_PANEL_PERMISSION = "sidePanel";

export interface PanelOptions {
  enabled?: boolean;
  path?: string;
  tabId?: number;
}

// One live side panel page. A tab-specific panel (tabId set) belongs to one tab,
// a global one (tabId null) to the whole window.
interface PanelInstance {
  key: string;
  extensionId: string;
  tabId: number | null;
  url: string;
  contents: WebContents | null;
  loaded: boolean;
  active: boolean;
  openedSent: boolean;
}

// What one window shows, modelled on Chrome's side panel registries: the
// window's last shown global panel, and per tab the tab-specific panel the
// user last had open there.
interface WindowPanels {
  instances: Map<string, PanelInstance>;
  showing: { key: string; extensionId: string } | null;
  globalActive: string | null;
  tabActive: Map<number, string>;
}

export interface SidePanelView {
  key: string;
  extensionId: string;
  url: string;
}

export interface WindowSidePanels {
  panels: SidePanelView[];
  showing: string | null;
}

const NO_TAB = -1;

const instanceKey = (extensionId: string, tabId: number | null) => `${extensionId}:${tabId ?? "global"}`;

function manifestOptions(extension: LoadedExtension): PanelOptions {
  const path = extension.manifest.side_panel?.default_path;
  return path ? { path, enabled: true } : {};
}

function available(options: PanelOptions): options is { path: string; enabled: true } {
  return options.enabled === true && typeof options.path === "string";
}

// chrome.sidePanel state for every window: options per extension (global and
// per tab), which panel each window shows, and the live panel pages.
export class SidePanelStore {
  private readonly options = new Map<string, Map<number, PanelOptions>>();
  private readonly windows = new Map<number, WindowPanels>();

  constructor(private readonly service: ExtensionService) {}

  private stateOf(window: ExtensionWindow): WindowPanels {
    let state = this.windows.get(window.id);
    if (!state) {
      state = { instances: new Map(), showing: null, globalActive: null, tabActive: new Map() };
      this.windows.set(window.id, state);
    }
    return state;
  }

  private extension(id: string): LoadedExtension | null {
    const extension = this.service.get(id);
    return extension?.hasApiPermission(SIDE_PANEL_PERMISSION) ? extension : null;
  }

  // Chrome's resolution: the tab's own options, else the extension's defaults,
  // else the manifest's side_panel.default_path. Keys come out sorted like Chrome's.
  getOptions(extension: LoadedExtension, tabId: number | null): PanelOptions {
    const stored = this.options.get(extension.id);
    const found = (tabId !== null ? stored?.get(tabId) : undefined) ?? stored?.get(NO_TAB) ?? manifestOptions(extension);
    const { enabled, path, tabId: owner } = found;
    return {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(path !== undefined ? { path } : {}),
      ...(owner !== undefined ? { tabId: owner } : {}),
    };
  }

  private tabOptions(extension: LoadedExtension, tabId: number): PanelOptions {
    return { ...this.options.get(extension.id)?.get(tabId) };
  }

  private hasTabPanel(extension: LoadedExtension, tabId: number | null): boolean {
    return tabId !== null && available(this.tabOptions(extension, tabId));
  }

  private hasGlobalPanel(extension: LoadedExtension): boolean {
    return available(this.getOptions(extension, null));
  }

  hasPanelForTab(extension: LoadedExtension, tabId: number | null): boolean {
    return available(this.getOptions(extension, tabId));
  }

  opensOnActionClick(extensionId: string): boolean {
    return opensSidePanelOnActionClick(extensionId);
  }

  setOpensOnActionClick(extensionId: string, open: boolean) {
    setOpensSidePanelOnActionClick(extensionId, open);
  }

  setOptions(extension: LoadedExtension, tabId: number | null, change: PanelOptions) {
    let stored = this.options.get(extension.id);
    if (!stored) this.options.set(extension.id, (stored = new Map()));
    const key = tabId ?? NO_TAB;
    const existing = stored.get(key);
    const merge = (target: PanelOptions) => {
      if (change.path !== undefined) target.path = change.path;
      if (change.enabled !== undefined) target.enabled = change.enabled;
    };
    if (existing) merge(existing);
    else if (tabId === null) {
      const fromManifest = manifestOptions(extension);
      merge(fromManifest);
      fromManifest.enabled ??= true;
      stored.set(key, fromManifest);
    } else stored.set(key, { enabled: change.enabled ?? true, ...(change.path !== undefined ? { path: change.path } : {}), tabId });
    this.optionsChanged(extension, tabId, change.path !== undefined);
  }

  private optionsChanged(extension: LoadedExtension, tabId: number | null, pathChanged: boolean) {
    const options = tabId === null ? this.getOptions(extension, null) : this.tabOptions(extension, tabId);
    const key = instanceKey(extension.id, tabId);
    for (const window of this.service.allWindows()) {
      const state = this.stateOf(window);
      if (!available(options)) {
        if (state.showing?.key === key) this.close(window);
        if (tabId !== null && state.tabActive.get(tabId) === extension.id) state.tabActive.delete(tabId);
        if (tabId === null && state.globalActive === extension.id) state.globalActive = null;
        this.dispose(window, key);
        continue;
      }
      const instance = state.instances.get(key);
      if (!instance || !pathChanged) continue;
      const url = this.urlFor(extension, options.path);
      if (instance.url === url) continue;
      if (state.showing?.key === key) {
        instance.url = url;
        window.host.sidePanelsChanged(false);
      } else this.dispose(window, key);
    }
  }

  private urlFor(extension: LoadedExtension, path: string): string {
    return /^https?:\/\//i.test(path) ? path : extension.url(path);
  }

  // The entry Chrome picks for an extension on a tab: its tab-specific panel
  // when one is enabled there, otherwise its global panel.
  private entryFor(extension: LoadedExtension, tabId: number | null): { extension: LoadedExtension; tabId: number | null } {
    return { extension, tabId: this.hasTabPanel(extension, tabId) ? tabId : null };
  }

  private activeTabId(window: ExtensionWindow): number | null {
    return window.host.tabs.active?.contentsId ?? null;
  }

  private show(window: ExtensionWindow, extension: LoadedExtension, tabId: number | null, options: { switchingTabs?: boolean } = {}) {
    const state = this.stateOf(window);
    const key = instanceKey(extension.id, tabId);
    const focus = !options.switchingTabs;
    if (state.showing?.key === key) {
      if (focus) window.host.sidePanelsChanged(true);
      return;
    }
    const previous = state.showing ? state.instances.get(state.showing.key) : null;
    if (previous && !options.switchingTabs) this.deactivate(window, previous);
    const activeTab = this.activeTabId(window);
    if (activeTab !== null) state.tabActive.delete(activeTab);
    if (tabId !== null) state.tabActive.set(tabId, extension.id);
    else state.globalActive = extension.id;
    let instance = state.instances.get(key);
    if (!instance) {
      const path = this.getOptions(extension, tabId).path!;
      instance = {
        key,
        extensionId: extension.id,
        tabId,
        url: this.urlFor(extension, path),
        contents: null,
        loaded: false,
        active: false,
        openedSent: false,
      };
      state.instances.set(key, instance);
    }
    state.showing = { key, extensionId: extension.id };
    if (!instance.active) {
      instance.active = true;
      this.sendOpened(window, instance);
    }
    this.prune(window);
    window.host.sidePanelsChanged(focus);
  }

  // Drops the pages nothing can bring back: not showing, not the window's open
  // global panel, and not any tab's open tab-specific panel.
  private prune(window: ExtensionWindow) {
    const state = this.stateOf(window);
    const kept = new Set([...state.tabActive].map(([tabId, extensionId]) => instanceKey(extensionId, tabId)));
    if (state.showing) kept.add(state.showing.key);
    if (state.globalActive) kept.add(instanceKey(state.globalActive, null));
    for (const key of [...state.instances.keys()]) if (!kept.has(key)) this.dispose(window, key);
  }

  // Chrome's SidePanelCoordinator::Close: hides the panel, forgets the window's
  // and the active tab's open panel, and drops every page no tab still needs.
  close(window: ExtensionWindow) {
    const state = this.stateOf(window);
    if (!state.showing) return;
    state.showing = null;
    const activeTab = this.activeTabId(window);
    if (activeTab !== null) state.tabActive.delete(activeTab);
    state.globalActive = null;
    this.prune(window);
    window.host.sidePanelsChanged(false);
  }

  private dispose(window: ExtensionWindow, key: string) {
    const state = this.stateOf(window);
    const instance = state.instances.get(key);
    if (!instance) return;
    state.instances.delete(key);
    this.deactivate(window, instance);
    window.host.sidePanelsChanged(false);
  }

  private deactivate(window: ExtensionWindow, instance: PanelInstance) {
    instance.active = false;
    if (!instance.openedSent) return;
    instance.openedSent = false;
    this.service.dispatch(instance.extensionId, "sidePanel.onClosed", [this.eventInfo(window, instance)]);
  }

  private sendOpened(window: ExtensionWindow, instance: PanelInstance) {
    if (!instance.active || !instance.loaded || instance.openedSent) return;
    instance.openedSent = true;
    this.service.dispatch(instance.extensionId, "sidePanel.onOpened", [this.eventInfo(window, instance)]);
  }

  private eventInfo(window: ExtensionWindow, instance: PanelInstance) {
    const path = new URL(instance.url).pathname;
    return instance.tabId === null ? { path, windowId: window.id } : { path, tabId: instance.tabId, windowId: window.id };
  }

  // The pane mounted the page for a panel instance.
  mounted(window: ExtensionWindow, key: string, contents: WebContents) {
    const instance = this.stateOf(window).instances.get(key);
    if (!instance || instance.contents === contents) return;
    instance.contents = contents;
    this.service.registerSurface(contents, window, "side-panel", instance.extensionId);
    const finished = () => {
      if (instance.loaded) return;
      instance.loaded = true;
      this.sendOpened(window, instance);
    };
    if (!contents.isLoading() && contents.getURL()) finished();
    else contents.once("did-finish-load", finished);
  }

  view(window: ExtensionWindow): WindowSidePanels {
    const state = this.stateOf(window);
    const showing = state.showing && state.instances.has(state.showing.key) ? state.showing.key : null;
    return {
      panels: [...state.instances.values()].map(({ key, extensionId, url }) => ({ key, extensionId, url })),
      showing,
    };
  }

  showingExtension(window: ExtensionWindow): string | null {
    return this.stateOf(window).showing?.extensionId ?? null;
  }

  // Chrome's Toggle for the action icon and the action's context menu.
  toggle(window: ExtensionWindow, extension: LoadedExtension) {
    if (this.showingExtension(window) === extension.id) {
      this.close(window);
      return;
    }
    const target = this.entryFor(extension, this.activeTabId(window));
    this.show(window, target.extension, target.tabId);
  }

  openForWindow(window: ExtensionWindow, extension: LoadedExtension) {
    if (!this.hasGlobalPanel(extension)) throw new Error(`No active side panel for windowId: ${window.id}`);
    const state = this.stateOf(window);
    const activeTab = this.activeTabId(window);
    const showingTabPanel = activeTab !== null && state.tabActive.has(activeTab);
    if (state.showing && showingTabPanel) {
      state.globalActive = extension.id;
      return;
    }
    const target = this.entryFor(extension, activeTab);
    this.show(window, target.extension, target.tabId);
  }

  openForTab(window: ExtensionWindow, extension: LoadedExtension, tabId: number) {
    if (!this.hasPanelForTab(extension, tabId)) throw new Error(`No active side panel for tabId: ${tabId}`);
    const state = this.stateOf(window);
    const activeTab = this.activeTabId(window);
    if (this.hasTabPanel(extension, tabId)) {
      if (tabId === activeTab) this.show(window, extension, tabId);
      else state.tabActive.set(tabId, extension.id);
      return;
    }
    if (tabId === activeTab) {
      this.show(window, extension, null);
      return;
    }
    state.tabActive.delete(tabId);
    if (!state.showing || !state.tabActive.has(activeTab ?? NO_TAB)) {
      const target = this.entryFor(extension, activeTab);
      this.show(window, target.extension, target.tabId);
      return;
    }
    state.globalActive = extension.id;
    this.prune(window);
  }

  closeForWindow(window: ExtensionWindow, extension: LoadedExtension) {
    if (!this.hasGlobalPanel(extension)) throw new Error(`No active side panel for windowId: ${window.id}`);
    const state = this.stateOf(window);
    const activeTab = this.activeTabId(window);
    if (activeTab !== null && state.tabActive.has(activeTab)) {
      if (state.globalActive === extension.id) state.globalActive = null;
      this.prune(window);
      return;
    }
    if (this.showingExtension(window) === extension.id) this.close(window);
  }

  closeForTab(window: ExtensionWindow, extension: LoadedExtension, tabId: number) {
    const state = this.stateOf(window);
    if (!this.hasTabPanel(extension, tabId)) throw new Error(`No active tab-specific side panel for tabId: ${tabId}`);
    if (state.tabActive.get(tabId) !== extension.id && state.showing?.key !== instanceKey(extension.id, tabId)) return;
    if (tabId === this.activeTabId(window)) {
      if (this.showingExtension(window) === extension.id) this.close(window);
      return;
    }
    state.tabActive.delete(tabId);
    this.dispose(window, instanceKey(extension.id, tabId));
  }

  // The page inside a panel called window.close().
  closeSelf(contents: WebContents) {
    for (const window of this.service.allWindows()) {
      const state = this.stateOf(window);
      for (const instance of state.instances.values()) {
        if (instance.contents !== contents) continue;
        if (state.showing?.key === instance.key) this.close(window);
        else this.dispose(window, instance.key);
        return;
      }
    }
  }

  // Chrome's MaybeShowEntryOnTabStripModelChanged: the new tab's own open panel,
  // else the extension that was showing, else the window's open global panel.
  tabActivated(window: ExtensionWindow) {
    const state = this.stateOf(window);
    const tabId = this.activeTabId(window);
    const tabOwn = tabId !== null ? state.tabActive.get(tabId) : undefined;
    if (!state.showing) {
      const extension = tabOwn ? this.extension(tabOwn) : null;
      if (extension) this.show(window, extension, tabId, { switchingTabs: true });
      return;
    }
    const candidates = [tabOwn, state.showing.extensionId, state.globalActive];
    for (const [index, id] of candidates.entries()) {
      const extension = id ? this.extension(id) : null;
      if (!extension) continue;
      if (index === 0) return this.show(window, extension, tabId, { switchingTabs: true });
      if (!this.hasGlobalPanel(extension)) continue;
      const target = this.entryFor(extension, tabId);
      return this.show(window, target.extension, target.tabId, { switchingTabs: true });
    }
    this.close(window);
  }

  // The showing entry is left in place so the next active tab can fall back
  // to the same extension's global panel, like Chrome does.
  tabRemoved(window: ExtensionWindow, tabId: number) {
    const state = this.stateOf(window);
    state.tabActive.delete(tabId);
    for (const instance of [...state.instances.values()]) {
      if (instance.tabId === tabId) this.dispose(window, instance.key);
    }
    for (const stored of this.options.values()) stored.delete(tabId);
  }

  windowRemoved(window: ExtensionWindow) {
    const state = this.windows.get(window.id);
    if (!state) return;
    for (const instance of state.instances.values()) this.deactivate(window, instance);
    this.windows.delete(window.id);
  }

  extensionUnloaded(id: string) {
    this.options.delete(id);
    for (const window of this.service.allWindows()) {
      const state = this.stateOf(window);
      if (this.showingExtension(window) === id) this.close(window);
      if (state.globalActive === id) state.globalActive = null;
      for (const [tabId, extensionId] of [...state.tabActive]) if (extensionId === id) state.tabActive.delete(tabId);
      for (const instance of [...state.instances.values()]) if (instance.extensionId === id) this.dispose(window, instance.key);
    }
  }
}
