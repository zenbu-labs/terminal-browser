import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

import { app } from "electron";
import { createRoot } from "@zenbu-labs/pixel";
import type {
  DevtoolsDock,
  DownloadProgress,
  EngineKeyEvent,
  Root,
  WebViewHandle,
  WebViewState,
} from "@zenbu-labs/pixel";
import { detect } from "@zenbu-labs/pixel/terminal";
import type { Pane, Terminal } from "@zenbu-labs/pixel/terminal";

import { bundledAsset } from "../assets";
import { CopyOnSelect, Grab, reactGrabPreloadPath } from "../grab/grab";
import { AgentPaneFinder } from "../grab/target";
import type { EmbeddedAgent } from "../grab/target";
import { zoomDirection } from "../zoom";
import type { ZoomDirection } from "../zoom";
import { TERMINAL_SOCKET_ENV, lastUrl, listApps, setLastUrl, settings, socketTerminal, store } from "pixel-store";
import type { InstanceRow, RegisteredApp } from "pixel-store";

import type { RecordTarget } from "../record/recorder";
import { RecordSession } from "../record/session";
import type { RecordActions } from "../record/types";
import { Registry } from "../registry";
import { Chrome } from "../ui/chrome";
import { ICONS } from "../ui/icons";
import type {
  ChromeActions,
  ChromeLayout,
  DevtoolsView,
  DownloadView,
  NewTabSuggestion,
  PageMenuItem,
  PageMenuView,
  TabActions,
  TabView,
} from "../ui/types";
import { clearSiteData } from "../page/site-data";
import { displayUrl, normalizeUrl, searchOrUrl, urlHost } from "../url";
import { START_URL } from "../pages/scheme";
import type { PageContext } from "../pages/scheme";
import { makeTheme } from "../ui/theme";
import { fuzzyScore } from "./fuzzy";
import {
  bindingLabel,
  defaultKeys,
  grabKeyLabel,
  isGrabKey,
  isRecordKey,
  listStep,
  matchesBinding,
  parseKeyBindings,
  recordKeyLabel,
} from "./keybindings";
import type { KeyBinding } from "./keybindings";
import { clampDevtoolsFraction, computeLayout, dividerFraction, recordBarHeight } from "./layout";
import type { DevtoolsPlacement, SurfaceLayout } from "./layout";
import { fetchSuggestions } from "./suggest";
import { TabManager } from "./tabs";
import type { Tab } from "./tabs";

export interface SessionContext {
  tty?: string;
  key: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  cdpPort: number | null;
  onClose(code: number): void;
}

export interface SessionHandle {
  ready: Promise<void>;
  close(code?: number): void;
  nudgeResize(): void;
  pageContext(): PageContext;
  showsStartPage(): boolean;
}

export function createSession(ctx: SessionContext): SessionHandle {
  const session = new Session(ctx);
  const ready = session.start().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    session.shutdown(1);
  });
  return {
    ready,
    close: (code = 0) => session.shutdown(code),
    nudgeResize: () => session.nudgeResize(),
    pageContext: () => session.pageContext(),
    showsStartPage: () => session.showsStartPage(),
  };
}


const FONT_FILE = path.join("fonts", "JetBrainsMono-Regular.ttf");

function bundledFontPath(): string {
  const found = bundledAsset(FONT_FILE);
  if (!found) throw new Error(`bundled font missing: ${FONT_FILE} (searched up from ${__dirname})`);
  return found;
}

interface NewTabState {
  query: string;
  suggestions: string[];
  apps: RegisteredApp[];
  appMatches: RegisteredApp[];
  index: number;
  seq: number;
  timer: ReturnType<typeof setTimeout> | null;
}

function safeListApps(): RegisteredApp[] {
  try {
    return listApps();
  } catch {
    return [];
  }
}

function matchApps(apps: RegisteredApp[], query: string): RegisteredApp[] {
  if (!query.trim()) return [];
  return apps
    .map((app) => ({ app, score: Math.max(fuzzyScore(query, app.name), fuzzyScore(query, app.id)) }))
    .filter((entry) => entry.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((entry) => entry.app);
}

function initialState(url: string): WebViewState {
  return {
    url,
    // why...
    title: "",
    loading: true,
    canGoBack: false,
    canGoForward: false,
    findMatches: null,
    zoom: 1,
    favicon: null,
  };
}

class Session {
  private readonly ctx: SessionContext;
  private readonly terminal: Terminal | null;
  private readonly marker: string;
  private ownPane: Pane | null = null;
  private finding: Promise<Pane | null> | null = null;
  private readonly argv: string[];
  private readonly sessionFlags: {
    clipboardRead: boolean;
  };
  private paletteApps: RegisteredApp[] = [];
  private readonly partition: string | null;
  private readonly socksPort: number | null;
  private readonly browserPreload: string;
  private paletteBinding: KeyBinding[] = [];
  private findBinding: KeyBinding[] = [];
  private devtoolsBinding: KeyBinding[] = [];
  private consoleBinding: KeyBinding[] = [];
  private noSuper = false;
  private readonly tabs: TabManager;
  private readonly fallbackState: WebViewState;

  private root: Root | null = null;
  private registry: Registry | null = null;

  private layout: ChromeLayout | null = null;
  private surfaceLayout: SurfaceLayout | null = null;
  private fontId = 0;

  private shuttingDown = false;
  private devtoolsDockSide: DevtoolsDock = "bottom";
  private devtoolsFraction = 0.4;
  private devtoolsPanel: string | null = null;
  private dividerHover = false;
  private dividerDragging = false;
  private dividerRenderAt = 0;
  private pageMenu:
    | {
        kind: "page";
        x: number;
        y: number;
        pageX: number;
        pageY: number;
        linkURL: string;
        selectionText: string;
      }
    | { kind: "toolbar" }
    | null = null;

  private findOpen = false;
  private urlEditOpen = false;
  private palette: { query: string; index: number } | null = null;
  private clearAllArmed = false;
  private newTab: NewTabState | null = null;
  private zoomHud: number | null = null;
  private zoomHudTimer: ReturnType<typeof setTimeout> | null = null;
  private download: DownloadView | null = null;
  private downloadTimer: ReturnType<typeof setTimeout> | null = null;
  private toast: { text: string; detail?: string; failed: boolean; alert: boolean } | null =
    null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private records = new Map<number, RecordSession>();
  private grabs = new Map<number, Grab>();
  private copyWatchers = new Map<number, CopyOnSelect>();
  private readonly copyOnSelect: boolean;
  private readonly grabIcon = bundledAsset(path.join("react-grab", "logo.png"));
  private readonly agentPanes: AgentPaneFinder;
  private shownRecord: RecordSession | null = null;
  private recordStarting = false;
  private readonly defaultUrl: string;
  private sessionHidden = false;

  constructor(ctx: SessionContext) {
    this.ctx = ctx;
    this.defaultUrl = ctx.env.TERMINAL_BROWSER_START_PAGE === "1" ? START_URL : "about:blank";
    const socket = ctx.env[TERMINAL_SOCKET_ENV];
    this.terminal = socket ? socketTerminal(socket) : detect(ctx.env);
    this.marker = `terminal-browser:${ctx.key}`;
    this.argv = ctx.argv;
    this.agentPanes = new AgentPaneFinder({
      terminal: this.terminal,
      parentTty: flagValue(this.argv, "--parent-tty"),
      cwd: ctx.cwd,
      self: () => this.findOwnPane(),
      embedded: embeddedAgent(ctx.env.TERMINAL_BROWSER_AGENT_BRIDGE, ctx.env.TERMINAL_BROWSER_AGENT_TOKEN),
    });
    this.sessionFlags = {
      clipboardRead: this.argv.includes("--allow-clipboard-read"),
    };
    const sshTarget = flagValue(this.argv, "--ssh");
    const socksPort = Number(flagValue(this.argv, "--socks-port"));
    this.socksPort = Number.isInteger(socksPort) && socksPort > 0 ? socksPort : null;
    this.partition = sshTarget ? `ssh-${sshTarget.replace(/[^A-Za-z0-9@._-]/g, "-")}` : null;
    this.fallbackState = initialState(this.initialUrl());
    this.copyOnSelect = ctx.env.TERMINAL_BROWSER_COPY_ON_SELECT === "1";
    this.browserPreload = reactGrabPreloadPath(this.copyOnSelect);
    this.tabs = new TabManager(
      {
        onActivated: () => {
          this.pageMenu = null;
          this.reconcileRecord();
          this.recalculateLayout();
          this.render();
          this.registry?.update();
          this.syncTitle();
        },
        onPageMenu: (params) => this.openPageMenu(params),
        onTabOpened: (opener, url) => this.records.get(opener.id)?.linkOpened(url),
        tabSwitchAllowed: () => !this.activeRecord()?.reviewing,
        onTabsChanged: () => {
          this.registry?.update();
          for (const record of [...this.records.values()]) {
            if (record.active && !this.tabs.has(record.target.tabId)) record.tabClosed();
          }
          for (const [id, grab] of [...this.grabs]) {
            if (this.tabs.has(id)) continue;
            grab.dispose();
            this.grabs.delete(id);
          }
          for (const [id, watcher] of [...this.copyWatchers]) {
            if (this.tabs.has(id)) continue;
            watcher.dispose();
            this.copyWatchers.delete(id);
          }
        },
        onActiveState: (state, urlChanged) => {
          if (urlChanged) rememberUrl(state.url);
          this.ensureCopyWatcher();
          if (Math.abs(state.zoom - this.lastZoom) > 0.001) this.showZoomHud(state.zoom);
          this.lastZoom = state.zoom;
          this.registry?.update();
          this.syncTitle();
        },
        requestRender: () => this.render(),
      },
      this.defaultUrl,
    );
  }

  private lastZoom = 1;

  async start(): Promise<void> {
    if (process.platform === "darwin") app.dock?.hide();
    await this.loadDevtoolsSettings();
    if (!this.ctx.tty) process.stdout.write(`\x1b]2;${this.marker}\x07`);
    this.root = createRoot({
      name: "terminal-browser",
      tty: this.ctx.tty,
      sessionEnv: this.ctx.env,
      cwd: this.ctx.cwd,
      onKey: (event) => this.handleKey(event),
      onResize: () => {
        // really?
        this.recalculateLayout();
        this.render();
      },
      onColors: () => this.render(),
      onVisible: (visible) => {
        if (this.sessionHidden === !visible) return;
        this.sessionHidden = !visible;
        this.render();
      },
      onQuit: () => this.shutdown(),
      onExit: (code) => this.ctx.onClose(code),
    });
    this.fontId = await this.root.registerFont(bundledFontPath());
    this.applyKeyBindings(this.root.info.kittyKeyboard);
    this.recalculateLayout();
    this.root.setPointerShape("default");
    this.tabs.create(this.fallbackState.url);
    this.registry = new Registry({
      key: this.ctx.key,
      tty: this.ctx.tty ?? null,
      where: async () => {
        const pane = await this.findOwnPane();
        return {
          terminal: this.terminal?.name ?? null,
          tab: pane?.tab ?? null,
          pane: pane?.id ?? null,
        };
      },
      splitDir: splitDirection(flagValue(this.argv, "--split-dir")),
      parentTty: flagValue(this.argv, "--parent-tty"),
      state: () => this.tabs.activeState ?? this.fallbackState,
      openTab: (url, cwd) => this.tabs.create(url ? normalizeUrl(url, cwd) : this.defaultUrl).id,
      activateTab: (id) => {
        if (!this.tabs.has(id) || this.activeRecord()?.reviewing) return false;
        this.tabs.activate(id);
        return true;
      },
      closeTab: (id) => {
        if (!this.tabs.has(id)) return false;
        this.tabs.close(id);
        return true;
      },
      agentTouch: (id) => this.tabs.touchAgentControl(id),
      agentRelease: () => this.tabs.releaseAgentControl(),
      viewport: () =>
        this.root ? { width: this.root.info.width, height: this.root.info.height } : null,
      tabs: () => this.tabs.registryView(),
      targets: () => this.tabs.targets(),
    });
    this.registry.setCdpPort(this.ctx.cdpPort);
    void this.findOwnPane();
    this.render();
  }

  private findOwnPane(): Promise<Pane | null> {
    if (this.ownPane) return Promise.resolve(this.ownPane);
    this.finding ??= (
      this.terminal?.getCurrentPane?.({ tty: this.ctx.tty ?? null, cwd: this.ctx.cwd }) ?? Promise.resolve(null)
    )
      .catch(() => null)
      .then((pane) => {
        this.ownPane = pane;
        this.finding = null;
        return pane;
      });
    return this.finding;
  }

  private applyKeyBindings(kittyKeyboard: boolean) {
    this.noSuper = !kittyKeyboard;
    const binding = (flag: string, fallback: string) =>
      parseKeyBindings(flagValue(this.argv, flag) ?? defaultBinding(fallback, this.noSuper));
    this.paletteBinding = binding("--palette-key", defaultKeys.palette);
    this.findBinding = binding("--find-key", defaultKeys.find);
    this.devtoolsBinding = binding("--devtools-key", defaultKeys.devtools);
    this.consoleBinding = binding("--console-key", defaultKeys.console);
  }

  private cmdHeld(event: EngineKeyEvent): boolean {
    return event.mods.super || (this.noSuper && event.mods.alt);
  }

  private accelHeld(event: EngineKeyEvent): boolean {
    return this.cmdHeld(event) || (process.platform === "linux" && event.mods.ctrl);
  }

  private closeOrShutdown(id: number) {
    if (this.tabs.count <= 1) this.shutdown();
    else this.tabs.close(id);
  }

  // What another pixel app shows on this browser's tab when the
  // browser is a guest in its pane.
  private syncTitle() {
    const state = this.tabs.activeState;
    this.root?.setTitle(state ? state.title || displayUrl(state.url) : "");
  }

  shutdown(code = 0) {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const record of this.records.values()) record.dispose();
    this.records.clear();
    this.shownRecord = null;
    this.registry?.dispose();
    this.registry = null;
    this.tabs.stopAll();
    if (this.root) this.root.stop(code);
    else this.ctx.onClose(code);
  }

  nudgeResize() {
    this.root?.nudgeResize();
  }

  // The app is started on this browser's tty, so if it is a pixel
  // app it joins this pane as a tab rather than opening one of its own.
  private launchApp(app: RegisteredApp) {
    const env = { ...this.ctx.env };
    if (this.registry) env.TERMINAL_BROWSER_INTEROP_TARGET = this.registry.socketPath;
    const tty = this.ctx.tty ?? process.env.PIXEL_TTY;
    if (tty) env.PIXEL_TTY = tty;
    try {
      const child = spawn(app.bin, app.args, {
        cwd: this.ctx.cwd,
        detached: true,
        stdio: tty ? "ignore" : "inherit",
        env,
      });
      child.on("error", () => this.showToast(`could not launch ${app.name}`, "failed"));
      child.unref();
    } catch {
      this.showToast(`could not launch ${app.name}`, "failed");
    }
  }

  private tabViews(): TabView[] {
    const active = this.tabs.active;
    return this.tabs.all().map((tab) => ({
      id: tab.id,
      url: tab.url,
      ref: tab.ref,
      active: tab.id === active?.id,
      hidden: this.sessionHidden,
      partition: this.partition,
      proxy: this.socksPort ? `socks5://127.0.0.1:${this.socksPort}` : null,
      preload: this.browserPreload,
      clipboardRead: this.sessionFlags.clipboardRead,
    }));
  }

  private devtoolsView(): DevtoolsView | null {
    if (!this.tabs.active?.devtools) return null;
    return { dock: this.devtoolsDockSide, panel: this.devtoolsPanel };
  }

  private readonly tabActions: TabActions = {
    state: (id, state) => this.tabs.stateChanged(id, state),
    openWindow: (id, details) => this.tabs.openWindow(id, details),
    contextMenu: (id, params) => this.tabs.contextMenu(id, params),
    download: (progress) => this.showDownload(progress),
    pointer: (id, event) => {
      if (id === this.tabs.active?.id) this.activeRecord()?.pointerSample(event);
    },
  };

  private render() {
    if (!this.root || !this.layout) return;
    this.root.render(
      <Chrome
        state={this.tabs.activeState ?? this.fallbackState}
        actions={this.actions}
        layout={this.layout}
        colors={this.root.info.colors}
        font={this.fontId}
        findOpen={this.findOpen}
        tabs={this.tabs.view()}
        newTab={
          this.newTab
            ? { suggestions: this.newTabRows(), index: this.newTab.index }
            : null
        }
        urlEdit={this.urlEditOpen}
        zoomHud={this.zoomHud}
        download={this.download}
        toast={this.toast}
        palette={
          this.palette
            ? {
              index: Math.min(this.palette.index, Math.max(0, this.filteredPalette().length - 1)),
              items: this.filteredPalette().map(({ id, label, shortcut }) => ({
                id,
                label,
                shortcut,
              })),
            }
            : null
        }
        pageMenu={this.pageMenuView()}
        dividerEngaged={this.dividerHover || this.dividerDragging}
        record={this.activeRecord()?.view() ?? null}
        recordSurface={this.activeRecord()?.surface ?? null}
        tabViews={this.tabViews()}
        tabActions={this.tabActions}
        devtools={this.devtoolsView()}
      />,
    );
  }

  private readonly actions: ChromeActions = {
    back: () => this.tabs.activeHandle?.back(),
    forward: () => this.tabs.activeHandle?.forward(),
    reload: () => {
      this.activeRecord()?.reloaded();
      this.tabs.activeHandle?.reload();
    },
    urlEdit: () => this.openUrlEdit(),
    urlEditCancel: () => this.closeUrlEdit(),
    urlSubmit: (text) => {
      this.closeUrlEdit();
      if (text.trim()) this.tabs.activeHandle?.loadURL(this.resolveInput(text));
    },
    findChange: (text) => this.tabs.activeHandle?.find(text),
    findNext: (forward) => this.tabs.activeHandle?.findNext(forward),
    findClose: () => this.closeFind(),
    paletteQuery: (text) => {
      if (!this.palette) return;
      this.palette.query = text;
      this.palette.index = 0;
      this.render();
    },
    paletteRun: (index) => this.runPalette(index),
    paletteClose: () => this.closePalette(),
    tabSwitch: (id) => this.tabs.activate(id),
    tabClose: (id) => this.closeOrShutdown(id),
    tabNew: () => this.openNewTabModal(),
    tabMenu: () => this.toggleToolbarMenu(),
    newTabQuery: (text) => this.newTabQuery(text),
    newTabSubmit: (text) => {
      this.closeNewTabModal();
      if (text.trim()) this.tabs.create(this.resolveInput(text));
    },
    newTabPick: (index) => this.pickNewTab(index),
    newTabCancel: () => this.closeNewTabModal(),
    devtoolsDividerHover: (hovering) => {
      this.dividerHover = hovering;
      this.root?.setPointerShape(
        hovering ? (this.devtoolsDockSide === "bottom" ? "row-resize" : "col-resize") : "default",
      );
      this.render();
    },
    devtoolsDividerDrag: (event) => {
      const page = this.layout?.page;
      const devtools = this.layout?.devtools;
      if (!page || !devtools) return;
      if (event.phase === "start") {
        this.dividerDragging = true;
        this.render();
      }
      if (event.phase === "move") {
        this.devtoolsFraction = dividerFraction(page, devtools, event.x, event.y);
        const now = Date.now();
        if (now - this.dividerRenderAt > 50) {
          this.dividerRenderAt = now;
          this.recalculateLayout();
          this.render();
        }
      }
      if (event.phase === "end") {
        this.dividerDragging = false;
        this.saveDevtoolsSettings();
        this.recalculateLayout();
        this.render();
      }
    },
    devtoolsAction: (action) => {
      if (action === "close") this.closeDevtools();
      else this.setDevtoolsDockSide(action === "dock-bottom" ? "bottom" : "right");
    },
    pageMenuAction: (id) => this.runPageMenu(id),
    pageMenuClose: () => this.closePageMenu(),
    record: this.recordActions(),
  };

  /** the record session lives with its tab; the active tab's session gets the UI and input */
  private activeRecord(): RecordSession | null {
    const tab = this.tabs.active;
    return tab ? this.records.get(tab.id) ?? null : null;
  }

  private reconcileRecord() {
    const current = this.activeRecord();
    if (this.shownRecord === current) return;
    const previous = this.shownRecord;
    this.shownRecord = current;
    if (previous?.active) previous.suspended();
    current?.resumed();
    this.syncRecordLayout();
  }

  private recordActions(): RecordActions {
    const active = () => this.activeRecord()?.actions;
    return {
      trackDrag: (event) => active()?.trackDrag(event),
      trimDrag: (edge, event) => active()?.trimDrag(edge, event),
      seek: (tMs) => active()?.seek(tMs),
      playToggle: () => active()?.playToggle(),
      stop: () => active()?.stop(),
      complete: () => active()?.complete(),
      discard: () => active()?.discard(),
      canvasDrag: (event) => active()?.canvasDrag(event),
      canvasWheel: (event) => active()?.canvasWheel(event),
      canvasMove: (event) => active()?.canvasMove(event),
      toolbarDrag: (event) => active()?.toolbarDrag(event),
      setTool: (tool) => active()?.setTool(tool),
      setColor: (color) => active()?.setColor(color),
      beginCrop: (scope) => active()?.beginCrop(scope),
      toggleCropMenu: () => active()?.toggleCropMenu(),
      closeCropMenu: () => active()?.closeCropMenu(),
      snapshot: () => active()?.snapshot(),
      dismissShot: (tMs) => active()?.dismissShot(tMs),
      textChange: (text) => active()?.textChange(text),
      textSubmit: (text) => active()?.textSubmit(text),
    };
  }

  private recordTarget(tab: Tab): RecordTarget {
    return {
      tabId: tab.id,
      handle: () => {
        const handle = tab.ref.current;
        if (!handle) throw new Error(`tab ${tab.id} is gone`);
        return handle;
      },
    };
  }

  private async startRecording() {
    if (this.recordStarting) return;
    const tab = this.tabs.active;
    if (!tab || !tab.ref.current || !this.root || this.records.has(tab.id)) return;
    const root = this.root;
    const whenActive = (fn: () => void) => () => {
      if (this.tabs.active?.id === tab.id) fn();
    };
    this.recordStarting = true;
    try {
      const session = await RecordSession.create(
        {
          root,
          layout: () => this.layout,
          canvasRect: () => {
            const surface = this.surfaceLayout!;
            return { x: surface.x, y: surface.y, width: surface.width, height: surface.height };
          },
          page: () => ({ url: tab.state.url, title: tab.state.title }),
          fontFile: () => bundledFontPath(),
          requestRender: () => this.render(),
          blurToOverlay: whenActive(() => this.blurToOverlay()),
          reviewStarted: whenActive(() => this.syncRecordLayout()),
          refocusPage: whenActive(() => this.refocusPage()),
          setKeyCapture: (keys) => {
            if (keys.length === 0 || this.tabs.active?.id === tab.id) root.setKeyCapture(keys);
          },
          setClipboard: (text) => root.setClipboard(text),
          toast: (name, state, detail) => this.showToast(name, state, detail),
          finished: () => {
            this.records.delete(tab.id);
            if (this.shownRecord?.target.tabId === tab.id) this.shownRecord = null;
            this.syncRecordLayout();
          },
        },
        this.recordTarget(tab),
      );
      this.records.set(tab.id, session);
    } catch (error) {
      this.showToast(error instanceof Error ? error.message : String(error), "failed");
      return;
    } finally {
      this.recordStarting = false;
    }
    this.reconcileRecord();
  }

  private syncRecordLayout() {
    this.recalculateLayout();
    this.render();
  }

  // Returns true when the browser consumed the key; anything else reaches the
  // focused page through pixel.
  private handleKey(event: EngineKeyEvent): boolean {
    const handle = this.tabs.activeHandle;
    if (event.kind === "release") return false;
    const quitKey = event.key === "q" || (process.platform === "darwin" && event.key === "c");
    if (event.mods.ctrl && quitKey) {
      this.shutdown();
      return true;
    }
    if (process.platform === "linux" && event.mods.ctrl && event.key === "c") {
      this.showToast("ctrl+q to quit", "alert");
      return true;
    }
    if (this.pageMenu) {
      this.closePageMenu();
      if (event.key === "escape") return true;
    }
    if (this.palette) {
      const step = listStep(event);
      if (event.key === "escape" || matchesBinding(event, this.paletteBinding)) {
        this.closePalette();
      } else if (step) {
        const count = this.filteredPalette().length;
        if (count > 0) {
          this.palette.index = (this.palette.index + step + count) % count;
          this.render();
        }
      } else if (event.key === "enter") this.runPalette();
      return true;
    }
    if (this.newTab) {
      const session = this.newTab;
      const step = listStep(event);
      if (event.key === "escape") this.closeNewTabModal();
      else if (step) {
        const count = this.newTabRows().length;
        if (count > 0) {
          session.index =
            step > 0
              ? session.index >= count - 1
                ? -1
                : session.index + 1
              : session.index <= -1
                ? count - 1
                : session.index - 1;
          this.render();
        }
      } else if (event.key === "enter") {
        if (session.index >= 0) this.pickNewTab(session.index);
        else this.actions.newTabSubmit(session.query);
      }
      return true;
    }
    if (this.urlEditOpen) {
      if (event.key === "escape") this.closeUrlEdit();
      return true;
    }
    if (!this.findOpen && this.activeRecord()?.handleKey(event)) return true;
    {
      if (isRecordKey(event)) {
        if (!this.activeRecord()) void this.startRecording();
        return true;
      }
      if (isGrabKey(event)) {
        void this.toggleGrab();
        return true;
      }
      if ((this.cmdHeld(event) || event.mods.ctrl) && event.key === "t") {
        if (!this.activeRecord()?.reviewing) this.openNewTabModal();
        return true;
      }
      if (matchesBinding(event, this.paletteBinding)) {
        this.openPalette();
        return true;
      }
      if (this.accelHeld(event) && event.key === "l") {
        this.openUrlEdit();
        return true;
      }
      if (matchesBinding(event, this.findBinding)) {
        this.openFind();
        return true;
      }
      if (matchesBinding(event, this.devtoolsBinding) || isPlainKey(event, "f12")) {
        this.toggleDevtools();
        return true;
      }
      if (matchesBinding(event, this.consoleBinding)) {
        this.toggleDevtoolsConsole();
        return true;
      }
    }
    if (event.key === "escape" && this.findOpen) {
      this.closeFind();
      return true;
    }
    if (event.key === "enter" && this.findOpen) {
      handle?.findNext(!event.mods.shift);
      return true;
    }
    {
      if (this.accelHeld(event) && event.key === "r") {
        this.activeRecord()?.reloaded();
        handle?.reload();
        return true;
      }
      if ((this.accelHeld(event) || event.mods.ctrl) && event.key === "[") {
        handle?.back();
        return true;
      }
      if ((this.accelHeld(event) || event.mods.ctrl) && event.key === "]") {
        handle?.forward();
        return true;
      }
      if (this.cmdHeld(event) || event.mods.ctrl) {
        const direction = zoomDirection(event.key);
        if (direction !== null) {
          const shifted = event.mods.shift || event.key === "+" || event.key === "_";
          if (shifted) this.zoomUi(direction);
          else this.applyZoom(direction);
          return true;
        }
      }
    }
    return false;
  }

  private applyZoom(direction: ZoomDirection) {
    this.tabs.activeHandle?.zoom(direction);
  }

  private uiZoom = 1;

  private zoomUi(direction: ZoomDirection) {
    const step = 1.1;
    const next = direction === 0 ? 1 : this.uiZoom * (direction > 0 ? step : 1 / step);
    this.uiZoom = Math.min(3, Math.max(0.5, Number(next.toFixed(3))));
    this.recalculateLayout();
    this.render();
  }

  private showZoomHud(factor: number) {
    this.zoomHud = factor;
    if (this.zoomHudTimer) clearTimeout(this.zoomHudTimer);
    this.zoomHudTimer = setTimeout(() => {
      this.zoomHud = null;
      this.zoomHudTimer = null;
      this.render();
    }, 1500);
    this.render();
  }

  private showDownload(progress: DownloadProgress) {
    const percent =
      progress.total > 0 ? Math.round((progress.received / progress.total) * 100) : null;
    if (
      this.download?.state === progress.state &&
      this.download.name === progress.name &&
      this.download.percent === percent
    ) {
      return;
    }
    this.download = { name: progress.name, percent, state: progress.state };
    if (this.downloadTimer) clearTimeout(this.downloadTimer);
    this.downloadTimer =
      progress.state === "progressing"
        ? null
        : setTimeout(() => {
          this.download = null;
          this.downloadTimer = null;
          this.render();
        }, 4000);
    this.render();
  }

  private showToast(text: string, state: "done" | "failed" | "alert", detail?: string) {
    this.toast = { text, detail, failed: state === "failed", alert: state === "alert" };
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast = null;
      this.toastTimer = null;
      this.render();
    }, 2000);
    this.render();
  }

  private blurToOverlay() {
    this.tabs.activeHandle?.blur();
  }

  private refocusPage() {
    this.tabs.activeHandle?.focus();
  }

  private toggleDevtools() {
    const tab = this.tabs.active;
    if (!tab) return;
    if (tab.devtools) this.closeDevtools();
    else this.openDevtools();
  }

  private toggleDevtoolsConsole() {
    const tab = this.tabs.active;
    if (!tab) return;
    if (tab.devtools) this.closeDevtools();
    else this.openDevtools("console");
  }

  private openDevtools(panel: string | null = null) {
    const tab = this.tabs.active;
    if (!tab || !this.root) return;
    tab.devtools = true;
    this.devtoolsPanel = panel;
    this.recalculateLayout();
    this.render();
  }

  private closeDevtools() {
    const tab = this.tabs.active;
    if (!tab?.devtools) return;
    tab.devtools = false;
    this.devtoolsPanel = null;
    this.recalculateLayout();
    this.render();
  }

  private setDevtoolsDockSide(dock: DevtoolsDock) {
    if (this.devtoolsDockSide === dock) return;
    this.devtoolsDockSide = dock;
    this.saveDevtoolsSettings();
    this.recalculateLayout();
    this.render();
  }

  private async loadDevtoolsSettings() {
    try {
      const [row] = await store().db.select().from(settings);
      if (!row) return;
      this.devtoolsDockSide = row.devtoolsDock;
      this.devtoolsFraction = clampDevtoolsFraction(row.devtoolsFraction);
    } catch { }
  }

  private saveDevtoolsSettings() {
    const row = {
      id: 1,
      devtoolsDock: this.devtoolsDockSide,
      devtoolsFraction: this.devtoolsFraction,
    };
    void store()
      .db.insert(settings)
      .values(row)
      .onConflictDoUpdate({ target: settings.id, set: row })
      .catch(() => { });
  }

  private openPageMenu(params: Electron.ContextMenuParams) {
    if (!this.surfaceLayout) return;
    if (this.palette || this.newTab || this.urlEditOpen) return;
    const scale = this.surfaceLayout.scale;
    this.pageMenu = {
      kind: "page",
      x: this.surfaceLayout.x + params.x * scale,
      y: this.surfaceLayout.y + params.y * scale,
      pageX: params.x,
      pageY: params.y,
      linkURL: params.linkURL,
      selectionText: params.selectionText.trim(),
    };
    this.render();
  }

  private closePageMenu() {
    if (!this.pageMenu) return;
    this.pageMenu = null;
    this.render();
  }

  private toggleToolbarMenu() {
    if (this.pageMenu?.kind === "toolbar") {
      this.closePageMenu();
      return;
    }
    if (this.palette || this.newTab || this.urlEditOpen) return;
    this.pageMenu = { kind: "toolbar" };
    this.render();
  }

  private runPageMenu(id: string) {
    const menu = this.pageMenu;
    this.closePageMenu();
    const tab = this.tabs.active;
    const handle = tab?.ref.current;
    if (!menu || !tab || !handle) return;
    switch (id) {
      case "grab":
        void this.toggleGrab();
        return;
      case "record":
        if (this.activeRecord()) this.activeRecord()?.actions.complete();
        else void this.startRecording();
        return;
      case "inspect": {
        if (menu.kind !== "page") {
          this.openDevtools();
          return;
        }
        const { pageX, pageY } = menu;
        const contents = handle.webContents;
        if (tab.devtools) {
          contents.inspectElement(pageX, pageY);
          return;
        }
        contents.once("devtools-opened", () => contents.inspectElement(pageX, pageY));
        this.openDevtools();
        return;
      }
    }
    if (menu.kind !== "page") return;
    switch (id) {
      case "copy":
        this.root?.setClipboard(menu.selectionText);
        return;
      case "copy-link":
        this.root?.setClipboard(menu.linkURL);
        return;
      case "open-link-tab":
        this.tabs.create(menu.linkURL);
        return;
    }
  }

  private activeGrab(): Grab | null {
    const tab = this.tabs.active;
    return tab ? this.grabs.get(tab.id) ?? null : null;
  }

  private ensureCopyWatcher(): void {
    if (!this.copyOnSelect) return;
    const tab = this.tabs.active;
    const handle = tab?.ref.current;
    if (!tab || !handle || this.copyWatchers.has(tab.id)) return;
    const watcher = new CopyOnSelect(handle, {
      copied: (text) => {
        this.root?.setClipboard(text);
        this.showToast("copied to clipboard", "done");
      },
    });
    this.copyWatchers.set(tab.id, watcher);
    void watcher.enable();
  }

  private grabFor(tab: Tab, handle: WebViewHandle): Grab {
    let grab = this.grabs.get(tab.id);
    if (!grab) {
      grab = new Grab(handle, {
        selected: (content) => void this.sendGrab(content),
      });
      this.grabs.set(tab.id, grab);
    }
    return grab;
  }

  private async toggleGrab() {
    const tab = this.tabs.active;
    const handle = tab?.ref.current;
    if (!tab || !handle) return;
    const grab = this.grabFor(tab, handle);
    try {
      if (grab.active) await grab.deactivate();
      else {
        this.agentPanes.warm();
        await grab.activate();
      }
    } catch (error) {
      this.showToast(error instanceof Error ? error.message : String(error), "failed");
    }
  }

  private async sendGrab(content: string) {
    this.root?.setClipboard(content);
    try {
      const target = await this.agentPanes.send(content);
      this.showToast(target ? "Sent to agent" : "copied to clipboard", "done");
    } catch (error) {
      this.showToast(error instanceof Error ? error.message : String(error), "failed");
    }
  }

  private grabMenuItem(): PageMenuItem {
    return {
      id: "grab",
      label: this.activeGrab()?.active ? "stop selection" : "send to agent",
      enabled: true,
      shortcut: grabKeyLabel,
      icon: this.grabIcon ? { kind: "image", src: this.grabIcon } : undefined,
    };
  }

  private toolMenuItems(): PageMenuItem[] {
    return [
      this.grabMenuItem(),
      {
        id: "record",
        label: this.activeRecord() ? "complete recording" : "record",
        enabled: true,
        shortcut: this.activeRecord() ? "" : recordKeyLabel,
        icon: { kind: "path", d: ICONS.record, tint: "red", weight: 4.5 },
      },
      {
        id: "inspect",
        label: "inspect",
        enabled: true,
        shortcut: bindingLabel(this.devtoolsBinding),
      },
    ];
  }

  private pageMenuView(): PageMenuView | null {
    if (!this.pageMenu || !this.layout) return null;
    if (this.pageMenu.kind === "toolbar") {
      return { x: this.layout.width, y: this.layout.toolbarHeight, items: this.toolMenuItems() };
    }
    const items: PageMenuItem[] = [
      ...(this.pageMenu.selectionText
        ? [
            {
              id: "copy",
              label: "copy",
              enabled: true,
              shortcut: process.platform === "darwin" ? "cmd+c" : "ctrl+c",
            },
          ]
        : []),
      ...(this.pageMenu.linkURL
        ? [
            { id: "open-link-tab", label: "open link in new tab", enabled: true, shortcut: "" },
            { id: "copy-link", label: "copy link address", enabled: true, shortcut: "" },
          ]
        : []),
      ...this.toolMenuItems(),
    ];
    return { x: this.pageMenu.x, y: this.pageMenu.y, items };
  }

  private openUrlEdit() {
    if (this.urlEditOpen) return;
    this.urlEditOpen = true;
    this.blurToOverlay();
    this.render();
  }

  private closeUrlEdit() {
    if (!this.urlEditOpen) return;
    this.urlEditOpen = false;
    this.refocusPage();
    this.render();
  }

  private openNewTabModal() {
    if (this.newTab) return;
    this.newTab = {
      query: "",
      suggestions: [],
      apps: safeListApps(),
      appMatches: [],
      index: -1,
      seq: 0,
      timer: null,
    };
    this.blurToOverlay();
    this.root?.setKeyCapture(["enter", "up", "down"]);
    this.render();
  }

  private newTabRows(): NewTabSuggestion[] {
    const session = this.newTab;
    if (!session) return [];
    return [
      ...session.appMatches.map((app) => ({
        kind: "app" as const,
        id: app.id,
        name: app.name,
      })),
      ...session.suggestions.map((text) => ({ kind: "search" as const, text })),
    ];
  }

  private pickNewTab(index: number) {
    const row = this.newTabRows()[index];
    if (!row) return;
    if (row.kind === "app") {
      const app = this.newTab?.apps.find((entry) => entry.id === row.id);
      this.closeNewTabModal();
      if (app) this.launchApp(app);
      return;
    }
    this.actions.newTabSubmit(row.text);
  }

  private closeNewTabModal() {
    if (!this.newTab) return;
    if (this.newTab.timer) clearTimeout(this.newTab.timer);
    this.newTab = null;
    this.root?.setKeyCapture(this.findOpen ? ["enter"] : []);
    this.refocusPage();
    this.render();
  }

  private newTabQuery(text: string) {
    const session = this.newTab;
    if (!session) return;
    session.query = text;
    session.index = -1;
    session.appMatches = matchApps(session.apps, text);
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    if (!text.trim()) {
      session.seq++;
      session.suggestions = [];
      this.render();
      return;
    }
    session.timer = setTimeout(() => this.requestSuggestions(text), 120);
    this.render();
  }

  private requestSuggestions(query: string) {
    const session = this.newTab;
    if (!session) return;
    const seq = ++session.seq;
    fetchSuggestions(query)
      .then((suggestions) => {
        if (this.newTab !== session || session.seq !== seq) return;
        session.suggestions = suggestions;
        if (session.index >= this.newTabRows().length) session.index = -1;
        this.render();
      })
      .catch(() => { });
  }

  private openFind() {
    if (this.findOpen) return;
    this.findOpen = true;
    this.blurToOverlay();
    this.root?.setKeyCapture(["enter"]);
    this.render();
  }

  private closeFind() {
    if (!this.findOpen) return;
    this.findOpen = false;
    this.tabs.activeHandle?.stopFind();
    this.root?.setKeyCapture([]);
    this.refocusPage();
    this.render();
  }

  private openPalette() {
    if (this.palette) return;
    this.paletteApps = safeListApps();
    this.palette = { query: "", index: 0 };
    this.blurToOverlay();
    this.root?.setKeyCapture(["enter", "up", "down"]);
    this.render();
  }

  private closePalette() {
    if (!this.palette) return;
    this.palette = null;
    this.root?.setKeyCapture(this.findOpen ? ["enter"] : []);
    this.refocusPage();
    this.render();
  }

  private runPalette(index?: number) {
    const items = this.filteredPalette();
    const chosen = items[index ?? this.palette?.index ?? 0];
    this.closePalette();
    chosen?.run();
  }

  private pageOrigin(): string | null {
    const url = this.tabs.activeState?.url ?? "";
    if (!/^https?:\/\//i.test(url)) return null;
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  }

  private clearSite(origin: string) {
    void clearSiteData(this.partition, origin).then(
      () => {
        this.showToast(`cleared ${urlHost(origin)}`, "done");
        this.tabs.activeHandle?.reload();
      },
      (error: unknown) => this.showToast(clearFailure(error), "failed"),
    );
  }

  // wiping every site logs the user out of everything, so it takes two runs
  private clearEverything() {
    if (!this.clearAllArmed) {
      this.clearAllArmed = true;
      setTimeout(() => {
        this.clearAllArmed = false;
      }, 5000);
      this.showToast("run again to clear every site", "alert");
      return;
    }
    this.clearAllArmed = false;
    void clearSiteData(this.partition).then(
      () => {
        this.showToast("cleared all site data", "done");
        this.tabs.activeHandle?.reload();
      },
      (error: unknown) => this.showToast(clearFailure(error), "failed"),
    );
  }

  private paletteActions(): PaletteAction[] {
    const devtoolsOpen = this.tabs.active?.devtools ?? false;
    const origin = this.pageOrigin();
    return [
      {
        id: "find",
        label: "find in page",
        shortcut: bindingLabel(this.findBinding),
        run: () => this.openFind(),
      },
      {
        id: "record",
        label: this.activeRecord()
          ? this.activeRecord()?.reviewing
            ? "complete recording"
            : "stop recording"
          : "record page",
        shortcut: this.activeRecord()?.reviewing ? "ctrl+enter" : recordKeyLabel,
        run: () => {
          const record = this.activeRecord();
          if (!record) void this.startRecording();
          else if (record.reviewing) record.actions.complete();
          else record.actions.stop();
        },
      },
      ...(origin
        ? [
          {
            id: "clear-site",
            label: `clear cookies and data for ${urlHost(origin)}`,
            shortcut: "",
            run: () => this.clearSite(origin),
          },
        ]
        : []),
      {
        id: "clear-all",
        label: this.clearAllArmed
          ? "clear every site — run again to confirm"
          : "clear cookies and data for all sites",
        shortcut: "",
        run: () => this.clearEverything(),
      },
      {
        id: "grab",
        label: this.activeGrab()?.active ? "stop selection" : "send to agent",
        shortcut: grabKeyLabel,
        run: () => void this.toggleGrab(),
      },
      {
        id: "devtools",
        label: devtoolsOpen ? "close devtools" : "open devtools",
        shortcut: bindingLabel(this.devtoolsBinding),
        run: () => this.toggleDevtools(),
      },
      ...(devtoolsOpen
        ? [
          {
            id: "devtools-dock",
            label:
              this.devtoolsDockSide === "bottom"
                ? "dock devtools right"
                : "dock devtools bottom",
            shortcut: "",
            run: () =>
              this.setDevtoolsDockSide(this.devtoolsDockSide === "bottom" ? "right" : "bottom"),
          },
        ]
        : []),
      ...this.paletteApps.map((app) => ({
        id: `app:${app.id}`,
        label: `open ${app.name}`,
        shortcut: "",
        run: () => this.launchApp(app),
      })),
      ...(this.ctx.env.TERMINAL_BROWSER_DEV_SOCKET
        ? [
          {
            id: "dev-reload",
            label: "reload instance",
            shortcut: "",
            run: () => this.requestDevReload(this.ctx.env.TERMINAL_BROWSER_DEV_SOCKET!),
          },
        ]
        : []),
    ];
  }

  private requestDevReload(socketPath: string) {
    const connection = net.connect(socketPath, () => connection.end("reload\n"));
    connection.on("error", () => {});
  }

  private filteredPalette(): PaletteAction[] {
    if (!this.palette) return [];
    const query = this.palette.query.toLowerCase();
    return this.paletteActions().filter((action) => action.label.toLowerCase().includes(query));
  }

  private recalculateLayout(placement: DevtoolsPlacement | null = this.devtoolsPlacement()) {
    if (!this.root) return;
    const reviewing = this.activeRecord()?.reviewing ?? false;
    const info = { ...this.root.info, basePx: this.root.info.basePx * this.uiZoom };
    const result = computeLayout(
      info,
      this.root.displayScale,
      reviewing ? null : placement,
      reviewing ? recordBarHeight(info) : 0,
    );
    this.layout = result.chrome;
    this.surfaceLayout = result.surface;
  }

  private devtoolsPlacement(): DevtoolsPlacement | null {
    return this.tabs.active?.devtools
      ? { dock: this.devtoolsDockSide, fraction: this.devtoolsFraction }
      : null;
  }

  private resolveInput(text: string): string {
    return normalizeUrl(searchOrUrl(text, this.ctx.cwd), this.ctx.cwd);
  }

  pageContext(): PageContext {
    const colors = this.root?.info.colors;
    return { cwd: this.ctx.cwd, theme: colors ? makeTheme(colors) : null };
  }

  showsStartPage(): boolean {
    return (this.tabs.activeState?.url ?? "").startsWith(START_URL);
  }

  private initialUrl(): string {
    const arg = this.argv.find((argument) => !argument.startsWith("-"));
    if (arg) return normalizeUrl(arg, this.ctx.cwd);
    try {
      const last = lastUrl()?.trim();
      if (last && /^https?:\/\//.test(last)) return last;
    } catch { }
    return this.defaultUrl;
  }
}

interface PaletteAction {
  id: string;
  label: string;
  shortcut: string;
  run(): void;
}

function isPlainKey(event: EngineKeyEvent, key: string): boolean {
  return (
    event.key === key &&
    !event.mods.super &&
    !event.mods.ctrl &&
    !event.mods.alt &&
    !event.mods.shift
  );
}

function defaultBinding(spec: string, noSuper: boolean): string {
  if (!noSuper) return spec;
  return spec
    .split(/\s+/)
    .map((chord) => {
      const parts = chord.split("+");
      const key = parts.pop()!;
      const mods = [...new Set(parts.map((mod) => (mod === "super" ? "alt" : mod)))];
      return [...mods, key].join("+");
    })
    .join(" ");
}

function splitDirection(value: string | null): InstanceRow["splitDir"] {
  const directions = ["right", "left", "down", "up"] as const;
  return directions.find((direction) => direction === value) ?? null;
}

function flagValue(argv: string[], flag: string): string | null {
  return (
    argv.find((argument) => argument.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? null
  );
}

function clearFailure(error: unknown): string {
  return `clearing failed: ${error instanceof Error ? error.message : String(error)}`;
}

function rememberUrl(url: string) {
  if (!/^https?:\/\//.test(url)) return;
  try {
    setLastUrl(url);
  } catch { }
}

function embeddedAgent(url: string | undefined, token: string | undefined): EmbeddedAgent | null {
  if (!url) return null;
  return {
    async send(content) {
      const response = await fetch(`${url.replace(/\/$/, "")}/agent-text`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ text: content }),
      });
      return response.ok;
    },
  };
}
