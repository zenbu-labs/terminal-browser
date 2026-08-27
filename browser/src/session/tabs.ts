import type { BrowserController } from "../page/controller";
import type { DevtoolsAction } from "../page/devtools";
import { initialBrowserState } from "../page/types";
import type { BrowserState } from "../page/types";
import type { TabRow } from "../ui/types";
import { displayUrl } from "../url";

export interface TabApp {
  name: string | null;
  id: string;
}

export interface TabOptions {
  app?: TabApp;
  partition?: string | null;
}

export interface Tab {
  readonly id: number;
  state: BrowserState;
  controller: BrowserController;
  targetId: string | null;
  app: TabApp | null;
}

export interface TabTarget {
  id: number;
  url: string;
  title: string;
  active: boolean;
  targetId: string | null;
  app?: TabApp | null;
  timeOrigin?: number | null;
}


export interface TabHost {
  createController(
    url: string,
    visible: boolean,
    onState: (state: BrowserState) => void,
    options: TabOptions & { tabId: number },
  ): BrowserController;
  onActivated(): void;
  onActiveState(state: BrowserState, urlChanged: boolean): void;
  onCursorChanged(): void;
  onDevtoolsChanged(): void;
  onDevtoolsAction(action: DevtoolsAction): void;
  onPageMenu(params: Electron.ContextMenuParams): void;
  onTabsChanged(): void;
  onTabOpened(opener: BrowserController, url: string): void;
  onTabClosed(id: number): void;
  tabSwitchAllowed(): boolean;
  requestRender(): void;
}

export class TabManager {
  private tabs: Tab[] = [];
  private activeId = 0;
  private seq = 1;

  constructor(
    private readonly host: TabHost,
    private readonly fallbackUrl: string,
  ) {

  }

  get active(): Tab | null {
    return this.tabs.find((tab) => tab.id === this.activeId) ?? null;
  }

  get activeController(): BrowserController | null {
    return this.active?.controller ?? null;
  }

  get activeState(): BrowserState | null {
    return this.active?.state ?? null;
  }

  get count(): number {
    return this.tabs.length;
  }

  
  create(url: string, activate = true, options: TabOptions = {}): Tab {
    const tab = {
      id: this.seq++,
      state: initialBrowserState(url),
      targetId: null,
      app: options.app ?? null,
    } as Tab;
    this.attachController(tab, url, activate, options);
    this.tabs.push(tab);
    if (activate) this.activate(tab.id);
    this.host.onTabsChanged();
    return tab;
  }

  private attachController(tab: Tab, url: string, visible: boolean, options: TabOptions) {
    tab.controller = this.host.createController(url, visible, (state) => {
      const urlChanged = state.url !== tab.state.url;
      tab.state = state;
      if (tab.id === this.activeId) this.host.onActiveState(state, urlChanged);
      this.host.requestRender();
    }, { ...options, tabId: tab.id });
    tab.controller.onCursorChange = () => {
      if (tab.id === this.activeId) this.host.onCursorChanged();
    };
    tab.controller.onOpenTab = (openUrl, activateNew) => {
      this.create(openUrl, activateNew);
      this.host.onTabOpened(tab.controller, openUrl);
    };
    tab.controller.onPopupChange = () => this.host.requestRender();
    tab.controller.onClosed = () => this.host.onTabClosed(tab.id);
    tab.controller.onDevtoolsChange = () => {
      if (tab.id === this.activeId) this.host.onDevtoolsChanged();
      else this.host.requestRender();
    };
    tab.controller.onDevtoolsAction = (action) => {
      if (tab.id === this.activeId) this.host.onDevtoolsAction(action);
    };
    tab.controller.onContextMenu = (params) => {
      if (tab.id === this.activeId) this.host.onPageMenu(params);
    };
    tab.targetId = null;
    void tab.controller.targetId().then((targetId) => {
      tab.targetId = targetId;
      this.host.onTabsChanged();
    });
  }

  activate(id: number) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab || (id !== this.activeId && !this.host.tabSwitchAllowed())) return;
    if (this.activeId !== id) {
      const previous = this.tabs.find((t) => t.id === this.activeId);
      previous?.controller.setVisible(false);
    }
    this.activeId = id;
    tab.controller.setVisible(true);
    tab.controller.focusContent();
    this.host.onActivated();
    this.host.requestRender();
  }

  close(id: number) {
    const at = this.tabs.findIndex((t) => t.id === id);
    if (at < 0) return;
    const [closed] = this.tabs.splice(at, 1);
    closed.controller.stop();
    if (this.activeId === id) {
      const fallback = this.tabs[Math.min(at, this.tabs.length - 1)];
      if (fallback) this.activate(fallback.id);
      else this.create(this.fallbackUrl);
    }
    this.host.onTabsChanged();
    this.host.requestRender();
  }

  has(id: number): boolean {
    return this.tabs.some((tab) => tab.id === id);
  }

  soleAppTab(): boolean {
    return this.tabs.length === 1 && this.tabs[0].app != null;
  }

  findByContents(contentsId: number): Tab | null {
    return this.tabs.find((tab) => tab.controller.hasContents(contentsId)) ?? null;
  }

  stateFor(controller: BrowserController): BrowserState | null {
    return this.tabs.find((tab) => tab.controller === controller)?.state ?? null;
  }

  private label(tab: Tab): string {
    if (tab.app?.name) return tab.app.name;
    return tab.state.title || displayUrl(tab.state.url);
  }

  view(): TabRow[] {
    return this.tabs.map((tab) => ({
      id: tab.id,
      title: this.label(tab),
      favicon: tab.app ? null : tab.state.favicon,
      active: tab.id === this.activeId,
      app: tab.app != null,
    }));
  }

  registryView(): TabTarget[] {
    return this.tabs.map((tab) => ({
      id: tab.id,
      url: tab.state.url,
      title: tab.state.title,
      active: tab.id === this.activeId,
      targetId: tab.targetId,
      app: tab.app,
    }));
  }

  async targets(): Promise<TabTarget[]> {
    return Promise.all(
      this.tabs.map(async (tab) => {
        if (!tab.targetId) tab.targetId = await tab.controller.targetId();
        return {
          id: tab.id,
          url: tab.state.url,
          title: tab.state.title,
          active: tab.id === this.activeId,
          targetId: tab.targetId,
          app: tab.app,
          timeOrigin: await tab.controller.fingerprint(),
        };
      }),
    );
  }

  eachController(fn: (controller: BrowserController) => void) {
    for (const tab of this.tabs) fn(tab.controller);
  }

  stopAll() {
    for (const tab of this.tabs) tab.controller.stop();
    this.tabs = [];
    this.activeId = 0;
  }
}
