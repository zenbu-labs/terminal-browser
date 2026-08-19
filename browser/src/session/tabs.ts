import type { BrowserController } from "../page/controller";
import type { DevtoolsAction } from "../page/devtools";
import { initialBrowserState } from "../page/types";
import type { BrowserState } from "../page/types";
import type { TabRow } from "../ui/types";
import { displayUrl } from "../url";

export interface Tab {
  readonly id: number;
  state: BrowserState;
  controller: BrowserController;
  targetId: string | null;
}

export interface TabTarget {
  id: number;
  url: string;
  title: string;
  active: boolean;
  targetId: string | null;
  timeOrigin?: number | null;
}


export interface TabHost {
  createController(
    url: string,
    visible: boolean,
    onState: (state: BrowserState) => void,
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

  
  create(url: string, activate = true): Tab {
    const tab = { id: this.seq++, state: initialBrowserState(url), targetId: null } as Tab;
    this.attachController(tab, url, activate);
    this.tabs.push(tab);
    if (activate) this.activate(tab.id);
    this.host.onTabsChanged();
    return tab;
  }

  private attachController(tab: Tab, url: string, visible: boolean) {
    tab.controller = this.host.createController(url, visible, (state) => {
      const urlChanged = state.url !== tab.state.url;
      tab.state = state;
      if (tab.id === this.activeId) this.host.onActiveState(state, urlChanged);
      this.host.requestRender();
    });
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

  /**
   * Captures where every tab sits, then stops every view. A view's session is fixed when it is
   * built, so a pane changes profile by handing these urls to `restore`.
   */
  teardown(): string[] {
    const urls = this.tabs.map((tab) => tab.state.url);
    for (const tab of this.tabs) tab.controller.stop();
    return urls;
  }

  /** Builds one replacement view per tab against whatever session the host hands out now. */
  restore(urls: string[]) {
    for (const [at, tab] of this.tabs.entries()) {
      const url = urls[at] ?? this.fallbackUrl;
      tab.state = initialBrowserState(url);
      this.attachController(tab, url, tab.id === this.activeId);
    }
    this.active?.controller.focusContent();
    this.host.onTabsChanged();
    this.host.onActivated();
    this.host.requestRender();
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

  stateFor(controller: BrowserController): BrowserState | null {
    return this.tabs.find((tab) => tab.controller === controller)?.state ?? null;
  }

  view(): TabRow[] {
    return this.tabs.map((tab) => ({
      id: tab.id,
      title: tab.state.title || displayUrl(tab.state.url),
      favicon: tab.state.favicon,
      active: tab.id === this.activeId,
    }));
  }

  registryView(): TabTarget[] {
    return this.tabs.map((tab) => ({
      id: tab.id,
      url: tab.state.url,
      title: tab.state.title,
      active: tab.id === this.activeId,
      targetId: tab.targetId,
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
