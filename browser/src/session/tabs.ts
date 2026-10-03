import { createRef } from "react";
import type { RefObject } from "react";
import type { OpenWindowDecision, WebViewHandle, WebViewState } from "@zenbu-labs/pixel";

import type { TabRow } from "../ui/types";
import { displayUrl } from "../url";
import { DOC_SCHEME } from "../pages/scheme";

export interface Tab {
  readonly id: number;
  readonly url: string;
  readonly ref: RefObject<WebViewHandle>;
  state: WebViewState;
  targetId: string | null;
  agentControlAt: number | null;
  devtools: boolean;
}

export interface TabTarget {
  id: number;
  url: string;
  title: string;
  active: boolean;
  targetId: string | null;
  timeOrigin?: number | null;
  agentControlled: boolean;
}

export interface TabHost {
  onActivated(): void;
  onActiveState(state: WebViewState, urlChanged: boolean): void;
  onPageMenu(params: Electron.ContextMenuParams): void;
  onTabsChanged(): void;
  onTabOpened(opener: Tab, url: string): void;
  tabSwitchAllowed(): boolean;
  requestRender(): void;
}

const parsedTtl = Number(process.env.TERMINAL_BROWSER_AGENT_CONTROL_MS);
const AGENT_CONTROL_TTL_MS = Number.isFinite(parsedTtl) && parsedTtl > 0 ? parsedTtl : 10_000;
const AGENT_CONTROL_SWEEP_MS = 500;

export class TabManager {
  private tabs: Tab[] = [];
  private activeId = 0;
  private seq = 1;
  private agentSweep: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly host: TabHost,
    private readonly fallbackUrl: string,
  ) {}

  get active(): Tab | null {
    return this.tabs.find((tab) => tab.id === this.activeId) ?? null;
  }

  get activeHandle(): WebViewHandle | null {
    return this.active?.ref.current ?? null;
  }

  get activeState(): WebViewState | null {
    return this.active?.state ?? null;
  }

  get count(): number {
    return this.tabs.length;
  }

  all(): readonly Tab[] {
    return this.tabs;
  }

  create(url: string, activate = true): Tab {
    const tab: Tab = {
      id: this.seq++,
      url,
      ref: createRef<WebViewHandle>(),
      state: {
        url,
        title: "",
        loading: true,
        canGoBack: false,
        canGoForward: false,
        findMatches: null,
        zoom: 1,
        favicon: null,
        audible: false,
        muted: false,
        capturing: { video: false, audio: false },
      },
      targetId: null,
      agentControlAt: null,
      devtools: false,
    };
    this.tabs.push(tab);
    if (activate) this.activate(tab.id);
    this.host.onTabsChanged();
    this.host.requestRender();
    return tab;
  }

  get(id: number): Tab | null {
    return this.tabs.find((tab) => tab.id === id) ?? null;
  }

  stateChanged(id: number, state: WebViewState) {
    const tab = this.get(id);
    if (!tab) return;
    const urlChanged = state.url !== tab.state.url;
    tab.state = state;
    if (!tab.targetId) void this.resolveTargetId(tab);
    if (tab.id === this.activeId) this.host.onActiveState(state, urlChanged);
    this.host.requestRender();
  }

  openWindow(id: number, details: Electron.HandlerDetails): OpenWindowDecision {
    const tab = this.get(id);
    if (!tab) return "deny";
    const wantsTab = details.disposition === "foreground-tab" || details.disposition === "background-tab";
    if (!wantsTab) {
      // a page-opened window (window.open with features) is a readable
      // same-origin child; never allow one onto a local file preview, or the
      // opener could read another local file's DOM through it
      if (details.url.startsWith(`${DOC_SCHEME}://`)) return "deny";
      return "popup";
    }
    this.create(details.url, details.disposition === "foreground-tab");
    this.host.onTabOpened(tab, details.url);
    return "deny";
  }

  contextMenu(id: number, params: Electron.ContextMenuParams) {
    if (id === this.activeId) this.host.onPageMenu(params);
  }

  private async resolveTargetId(tab: Tab) {
    const handle = tab.ref.current;
    if (!handle) return;
    try {
      const info = (await handle.cdp("Target.getTargetInfo")) as {
        targetInfo?: { targetId?: string };
      };
      tab.targetId = info.targetInfo?.targetId ?? null;
    } catch {
      tab.targetId = null;
    }
    if (tab.targetId) this.host.onTabsChanged();
  }

  private async fingerprint(tab: Tab): Promise<number | null> {
    const handle = tab.ref.current;
    if (!handle) return null;
    try {
      const result = (await handle.cdp("Runtime.evaluate", {
        expression: "performance.timeOrigin",
        returnByValue: true,
      })) as { result?: { value?: number } };
      return typeof result.result?.value === "number" ? result.result.value : null;
    } catch {
      return null;
    }
  }

  activate(id: number) {
    const tab = this.get(id);
    if (!tab || (id !== this.activeId && !this.host.tabSwitchAllowed())) return;
    this.activeId = id;
    tab.ref.current?.focus();
    this.host.onActivated();
    this.host.requestRender();
  }

  close(id: number) {
    const at = this.tabs.findIndex((t) => t.id === id);
    if (at < 0) return;
    this.tabs.splice(at, 1);
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

  touchAgentControl(id: number): boolean {
    const tab = this.get(id);
    if (!tab) return false;
    const fresh = tab.agentControlAt == null;
    tab.agentControlAt = Date.now();
    this.startAgentSweep();
    if (fresh) {
      this.host.onTabsChanged();
      this.host.requestRender();
    }
    return true;
  }

  releaseAgentControl() {
    this.stopAgentSweep();
    let changed = false;
    for (const tab of this.tabs) {
      if (tab.agentControlAt == null) continue;
      tab.agentControlAt = null;
      changed = true;
    }
    if (!changed) return;
    this.host.onTabsChanged();
    this.host.requestRender();
  }

  private startAgentSweep() {
    if (this.agentSweep) return;
    this.agentSweep = setInterval(() => {
      const cutoff = Date.now() - AGENT_CONTROL_TTL_MS;
      let changed = false;
      let remaining = false;
      for (const tab of this.tabs) {
        if (tab.agentControlAt == null) continue;
        if (tab.agentControlAt < cutoff) {
          tab.agentControlAt = null;
          changed = true;
        } else {
          remaining = true;
        }
      }
      if (!remaining) this.stopAgentSweep();
      if (changed) {
        this.host.onTabsChanged();
        this.host.requestRender();
      }
    }, AGENT_CONTROL_SWEEP_MS);
  }

  private stopAgentSweep() {
    if (!this.agentSweep) return;
    clearInterval(this.agentSweep);
    this.agentSweep = null;
  }

  findByContents(contentsId: number): Tab | null {
    return (
      this.tabs.find((tab) => {
        try {
          return tab.ref.current?.webContents.id === contentsId;
        } catch {
          return false;
        }
      }) ?? null
    );
  }

  findByHandle(handle: WebViewHandle | null): Tab | null {
    if (!handle) return null;
    return this.tabs.find((tab) => tab.ref.current === handle) ?? null;
  }

  private label(tab: Tab): string {
    return tab.state.title || displayUrl(tab.state.url);
  }

  view(): TabRow[] {
    return this.tabs.map((tab) => ({
      id: tab.id,
      title: this.label(tab),
      favicon: tab.state.favicon,
      active: tab.id === this.activeId,
      agentControlled: tab.agentControlAt != null,
      audible: tab.state.audible,
      muted: tab.state.muted,
      capturing: tab.state.capturing,
    }));
  }

  registryView(): TabTarget[] {
    return this.tabs.map((tab) => ({
      id: tab.id,
      url: tab.state.url,
      title: tab.state.title,
      active: tab.id === this.activeId,
      targetId: tab.targetId,
      agentControlled: tab.agentControlAt != null,
    }));
  }

  async targets(): Promise<TabTarget[]> {
    return Promise.all(
      this.tabs.map(async (tab) => {
        if (!tab.targetId) await this.resolveTargetId(tab);
        return {
          id: tab.id,
          url: tab.state.url,
          title: tab.state.title,
          active: tab.id === this.activeId,
          targetId: tab.targetId,
          timeOrigin: await this.fingerprint(tab),
          agentControlled: tab.agentControlAt != null,
        };
      }),
    );
  }

  stopAll() {
    this.stopAgentSweep();
    this.tabs = [];
    this.activeId = 0;
  }
}
