import fs from "node:fs";
import path from "node:path";

import { app, clipboard, ipcMain, nativeImage, screen } from "electron";
import { createRequire } from "node:module";
import type { IpcMainEvent, Session as ElectronSession } from "electron";
import { createRoot } from "pixel-react";
import type { DragEvent, EngineKeyEvent, PixelRoot, Surface } from "pixel-react";
import { detect } from "pixel-terminals";
import type { Pane, Terminal } from "pixel-terminals";

import { importChromeCookies, listCookieSources } from "../cookies";
import type { CookieImportRequest, CookieImportResult, CookieSource } from "../cookies";
import { browserSession, configureBrowserSession } from "../page/browser-session";
import type { DownloadProgress } from "../page/browser-session";
import { BrowserController } from "../page/controller";
import { initOffscreenMode } from "../page/offscreen";
import { initialBrowserState } from "../page/types";
import type { BrowserState, BrowserSurfaceLayout } from "../page/types";
import { zoomDirection } from "../page/zoom";
import type { ZoomDirection } from "../page/zoom";
import {
  clearProfileData,
  createProfile,
  deleteProfile,
  listProfiles,
  noteProfileUsed,
  partitionFor,
  profileForNewPane,
  renameProfile,
  resolveProfile,
} from "../profiles";
import type { BrowserProfile } from "../profiles";
import { lastUrl, setLastUrl, settings, store } from "pixel-store";
import type { DevtoolsDock, InstanceRow } from "pixel-store";

import { RecordSession } from "../record/session";
import type { RecordActions } from "../record/types";
import { Registry } from "../registry";
import type { ProfileListing } from "../registry";
import { Chrome } from "../ui/chrome";
import { ICONS } from "../ui/icons";
import type {
  ChromeActions,
  ChromeLayout,
  DownloadView,
  ImportHintView,
  PageMenuItem,
  PageMenuView,
  PopupView,
  ProfileMenuView,
} from "../ui/types";
import { normalizeUrl, searchOrUrl } from "../url";
import { bindingLabel, defaultKeys, isRecordKey, listStep, matchesBinding, parseKeyBindings, recordKeyLabel } from "./keybindings";
import type { KeyBinding } from "./keybindings";
import { clampDevtoolsFraction, computeLayout, dividerFraction, recordBarHeight } from "./layout";
import type { DevtoolsPlacement } from "./layout";
import { fetchSuggestions } from "./suggest";
import { TabManager } from "./tabs";

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
  };
}

const DEFAULT_URL = "https://github.com/zenbu-labs";

const APP_MODE_FLAGS = [
  "--no-toolbar",
  "--no-shortcuts",
  "--no-context-menu",
  "--no-overlays",
  "--no-frame",
  "--allow-clipboard-read",
];

const FONT_FILE = path.join("assets", "fonts", "JetBrainsMono-Regular.ttf");

const API_PRELOAD_SOURCE = `if (process.isMainFrame) {
  const { ipcRenderer } = require("electron");
  let current = null;
  const subscribers = new Set();
  ipcRenderer.on("terminal-browser:theme", (_event, theme) => {
    current = theme;
    for (const subscriber of subscribers) {
      try { subscriber(theme); } catch {}
    }
  });
  ipcRenderer.send("terminal-browser:theme-request");
  globalThis.terminalBrowser = {
    theme: () => current,
    onTheme(subscriber) {
      subscribers.add(subscriber);
      if (current) { try { subscriber(current); } catch {} }
      return () => subscribers.delete(subscriber);
    },
    quit: () => ipcRenderer.send("terminal-browser:quit"),
  };
}
`;

let apiPreloadFile: string | null = null;
function apiPreloadPath(): string {
  if (!apiPreloadFile) {
    apiPreloadFile = path.join(app.getPath("userData"), "terminal-browser-api-preload.js");
    fs.writeFileSync(apiPreloadFile, API_PRELOAD_SOURCE);
  }
  return apiPreloadFile;
}

const registeredPreloads = new WeakMap<ElectronSession, Set<string>>();
function registerPreloadOnce(ses: ElectronSession, filePath: string) {
  let seen = registeredPreloads.get(ses);
  if (!seen) registeredPreloads.set(ses, (seen = new Set()));
  if (seen.has(filePath)) return;
  seen.add(filePath);
  ses.registerPreloadScript({ type: "frame", filePath });
}

function bundledFontPath(): string {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, FONT_FILE);
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) {
      throw new Error(`bundled font missing: ${FONT_FILE} (searched up from ${__dirname})`);
    }
  }
}


interface NewTabState {
  query: string;
  suggestions: string[];
  index: number;
  seq: number;
  timer: ReturnType<typeof setTimeout> | null;
}

function cookieImportWarnings(result: CookieImportResult): string[] {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const add = (warning: string) => {
    if (seen.has(warning)) return;
    seen.add(warning);
    warnings.push(warning);
  };
  for (const warning of result.warnings) add(warning);
  if (result.undecryptable > 0) {
    add(
      `${result.undecryptable} ${result.browser} cookies would not decrypt with the key from your login keychain, so those sites will still ask you to sign in.`,
    );
  }
  if (result.rejected > 0) {
    add(`${result.rejected} cookies were rejected by this browser's cookie store.`);
  }
  return warnings;
}

const IMPORT_SUMMARY_NAMES = 4;

function cookieSourceSummary(sources: CookieSource[]): string {
  if (sources.length === 0) return "No supported browsers detected.";
  const named = sources.slice(0, IMPORT_SUMMARY_NAMES).map((source) => source.displayName).join(", ");
  const rest = sources.length - IMPORT_SUMMARY_NAMES;
  return rest > 0 ? `Detected: ${named}, +${rest} more.` : `Detected: ${named}.`;
}

// Each import decrypts row by row and rewrites a whole cookie store, so every pane in this
// process waits its turn rather than multiplying that work.
let importingCookies = false;

class Session {
  private readonly ctx: SessionContext;
  private readonly terminal: Terminal | null;
  private readonly marker: string;
  private ownPane: Pane | null = null;
  private finding: Promise<Pane | null> | null = null;
  private readonly argv: string[];
  private readonly hideToolbar: boolean;
  /** --no-shortcuts at launch, and the focus-mode toggle at runtime: every key goes to the page. */
  private noShortcuts: boolean;
  private readonly noContextMenu: boolean;
  private readonly noOverlays: boolean;
  private readonly noFrame: boolean;
  private readonly tabsAsPopups: boolean;
  private readonly clipboardRead: boolean;
  /** --partition pins this pane's storage directly, which puts it on no profile at all. */
  private readonly explicitPartition: string | null;
  private profile: BrowserProfile | null;
  private readonly preload: string | null;
  private readonly mainScript: string | null;
  private readonly onThemeRequest = (event: IpcMainEvent) => {
    if (!this.ownsSender(event)) return;
    const payload = this.themePayload();
    if (payload) event.sender.send("terminal-browser:theme", payload);
  };
  private readonly onQuitRequest = (event: IpcMainEvent) => {
    if (!this.ownsSender(event)) return;
    this.shutdown();
  };
  private paletteBinding: KeyBinding[] = [];
  private findBinding: KeyBinding[] = [];
  private devtoolsBinding: KeyBinding[] = [];
  private consoleBinding: KeyBinding[] = [];
  private noSuper = false;
  private readonly tabs: TabManager;
  private readonly fallbackState: BrowserState;

  private root: PixelRoot | null = null;
  private popupSurface: Surface | null = null;
  private devtoolsSurface: Surface | null = null;
  private registry: Registry | null = null;

  private layout: ChromeLayout | null = null;
  private surfaceLayout: BrowserSurfaceLayout | null = null;
  private devtoolsLayout: BrowserSurfaceLayout | null = null;
  private displayScale = 1;
  private fontId = 0;
  private windowBg = "#1e2026";

  private browserFocused = false;
  private shuttingDown = false;
  private pageHover = false;
  private popupHover = false;
  private devtoolsHover = false;
  private devtoolsWasFocused = false;
  private devtoolsDockSide: DevtoolsDock = "bottom";
  private devtoolsFraction = 0.4;
  private dividerHover = false;
  private dividerDragging = false;
  private dividerResizeAt = 0;
  private pageMenu: {
    x: number;
    y: number;
    pageX: number;
    pageY: number;
    linkURL: string;
    selectionText: string;
  } | null = null;
  private sentCursor: string | null = null;

  private findOpen = false;
  private urlEditOpen = false;
  private palette: { query: string; index: number } | null = null;
  private newTab: NewTabState | null = null;
  private zoomHud: number | null = null;
  private zoomHudTimer: ReturnType<typeof setTimeout> | null = null;
  private cellFollow: { height: number; basePx: number } | null = null;
  private download: DownloadView | null = null;
  private downloadTimer: ReturnType<typeof setTimeout> | null = null;
  private toast: { text: string; detail?: string; failed: boolean; alert: boolean } | null =
    null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private records = new Map<BrowserController, RecordSession>();
  private shownRecord: RecordSession | null = null;
  private recordStarting = false;
  private importHintOpen = false;
  private importSummary = "No supported browsers detected.";
  private profileMenuOpen = false;
  private profileContext: string | null = null;
  private profilePrompt: { kind: "create" | "rename"; text: string } | null = null;

  constructor(ctx: SessionContext) {
    this.ctx = ctx;
    this.terminal = detect(ctx.env);
    this.marker = `terminal-browser:${ctx.key}`;
    this.argv = ctx.argv.includes("--app-mode") ? [...ctx.argv, ...APP_MODE_FLAGS] : ctx.argv;
    this.hideToolbar = this.argv.includes("--no-toolbar");
    this.noShortcuts = this.argv.includes("--no-shortcuts");
    this.noContextMenu = this.argv.includes("--no-context-menu");
    this.noOverlays = this.argv.includes("--no-overlays");
    this.noFrame = this.argv.includes("--no-frame");
    this.tabsAsPopups = this.argv.includes("--open-tabs-in-popup-stack");
    this.clipboardRead = this.argv.includes("--allow-clipboard-read");
    this.explicitPartition = flagValue(this.argv, "--partition");
    this.profile = this.explicitPartition
      ? null
      : profileForNewPane(flagValue(this.argv, "--profile"), flagValue(this.argv, "--parent-tty"));
    if (this.profile) noteProfileUsed(this.profile.slug);
    this.preload = flagValue(this.argv, "--preload");
    this.mainScript = flagValue(this.argv, "--main-script");
    this.fallbackState = initialBrowserState(this.initialUrl());
    configureBrowserSession(this.sessionPartition(), (progress) => this.showDownload(progress));
    this.tabs = new TabManager(
      {
        createController: (url, visible, onState) =>
          new BrowserController(
            this.root!.createSurface(),
            this.popupSurface!,
            this.devtoolsSurface!,
            this.surfaceLayout!,
            url,
            this.ctx.cwd,
            this.windowBg,
            visible,
            this.sessionPartition(),
            this.tabsAsPopups,
            this.clipboardRead,
            this.ctx.key,
            onState,
          ),
        onActivated: () => {
          this.browserFocused = true;
          this.pageMenu = null;
          this.reconcileRecord();
          this.syncDevtoolsLayout();
          this.syncCursor();
          this.registry?.update();
        },
        onDevtoolsChanged: () => this.syncDevtoolsLayout(),
        onDevtoolsAction: (action) => {
          if (action === "close") this.tabs.activeController?.closeDevtools();
          else this.setDevtoolsDockSide(action === "dock-bottom" ? "bottom" : "right");
        },
        onPageMenu: (params) => this.openPageMenu(params),
        onTabOpened: (opener, url) => this.records.get(opener)?.linkOpened(url),
        onTabClosed: (id) => this.closeOrShutdown(id),
        tabSwitchAllowed: () => !this.activeRecord()?.reviewing,
        onTabsChanged: () => {
          this.registry?.update();
          for (const record of [...this.records.values()]) {
            if (record.active && this.tabs.stateFor(record.controller) == null) record.tabClosed();
          }
        },
        onActiveState: (state, urlChanged) => {
          if (urlChanged) rememberUrl(state.url);
          this.registry?.update();
        },
        onCursorChanged: () => this.syncCursor(),
        requestRender: () => this.render(),
      },
      DEFAULT_URL,
    );
  }

  async start(): Promise<void> {
    if (process.platform === "darwin") app.dock?.hide();
    await this.loadDevtoolsSettings();
    this.loadImportHint();
    if (!this.ctx.tty) process.stdout.write(`\x1b]2;${this.marker}\x07`);
    this.displayScale = this.hostDisplayScale();
    this.root = createRoot({
      tty: this.ctx.tty,
      wrapper: this.terminal?.wrapper,
      sessionEnv: this.ctx.env,
      keyEventTypes: true,
      // The engine's devtools inspect this chrome's own layout tree, which is not what a person
      // clicking "devtools" in a browser is asking for. Kept for whoever works on the chrome.
      devtools: process.env.TERMINAL_BROWSER_ENGINE_DEVTOOLS === "1",
      onKey: (event) => this.handleKey(event),
      onPaste: (text) => {
        const browser = this.tabs.activeController;
        if (browser?.popup) browser.popup.input.paste(text);
        else if (this.browserFocused && browser?.devtoolsFocused) {
          browser.devtools?.input.paste(text);
        } else if (this.browserFocused) browser?.paste(text);
      },
      onPasteImage: (image) => {
        const browser = this.tabs.activeController;
        if (browser?.popup) browser.popup.input.pasteImage(image);
        else if (this.browserFocused && browser?.devtoolsFocused) {
          browser.devtools?.input.pasteImage(image);
        } else if (this.browserFocused) browser?.pasteImage(image);
      },
      onFocus: (focused) => this.tabs.activeController?.setActive(focused),
      onResize: () => {
        this.followCellZoom();
        this.recalculateLayout();
        if (this.surfaceLayout) this.tabs.activeController?.resize(this.surfaceLayout);
        if (this.devtoolsLayout) this.tabs.activeController?.devtools?.resize(this.devtoolsLayout);
        this.render();
      },
      onColors: () => {
        this.windowBg = this.themeBackground();
        this.tabs.eachController((c) => void c.setBackground(this.windowBg));
        this.render();
        this.broadcastTheme();
      },
      onEngineExit: (error) => {
        if (error) process.stderr.write(`terminal-browser engine: ${error}\n`);
        this.shutdown(error ? 1 : 0);
      },
    });
    initOffscreenMode(this.root.sharedTextures);
    this.fontId = await this.root.registerFont(bundledFontPath());
    this.applyKeyBindings(this.root.info.kittyKeyboard);
    this.popupSurface = this.root.createSurface();
    this.devtoolsSurface = this.root.createSurface();
    this.followCellZoom();
    this.recalculateLayout();
    this.root.setPointerShape("default");
    this.windowBg = this.themeBackground();
    this.installEmbedderApi();
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
      profile: () => this.profile?.slug ?? null,
      state: () => this.tabs.activeState ?? this.fallbackState,
      openTab: (url, cwd) => this.tabs.create(url ? normalizeUrl(url, cwd) : DEFAULT_URL).id,
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
      viewport: () =>
        this.root ? { width: this.root.info.width, height: this.root.info.height } : null,
      tabs: () => this.tabs.registryView(),
      targets: () => this.tabs.targets(),
      importCookies: (request) => this.runCookieImport(request),
      cookieSources: () => listCookieSources(),
      profiles: () => this.profileListing(),
      createProfile: (name) => {
        const created = createProfile(name);
        this.render();
        return created;
      },
      renameProfile: (selector, name) => this.renameBySelector(selector, name),
      deleteProfile: (selector) => this.deleteBySelector(selector),
      clearProfile: (selector) => this.clearBySelector(selector),
      switchProfile: (selector) => this.switchProfile(selector),
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
    // we should use 2 shortcuts for console, also not sure if console actually works as expected
    this.devtoolsBinding = binding("--devtools-key", defaultKeys.devtools);
    this.consoleBinding = binding("--console-key", defaultKeys.console);
  }

  private cmdHeld(event: EngineKeyEvent): boolean {
    return event.mods.super || (this.noSuper && event.mods.alt);
  }

  private accelHeld(event: EngineKeyEvent): boolean {
    return this.cmdHeld(event) || (process.platform === "linux" && event.mods.ctrl);
  }

  private clipboardHeld(event: EngineKeyEvent): boolean {
    if (this.cmdHeld(event)) return true;
    return (
      process.platform === "linux" && event.mods.ctrl && !event.mods.shift && !event.mods.alt
    );
  }

  private isPasteKey(event: EngineKeyEvent): boolean {
    return event.kind === "press" && this.clipboardHeld(event) && event.key === "v";
  }

  private isCopyKey(event: EngineKeyEvent): boolean {
    return event.kind === "press" && this.clipboardHeld(event) && event.key === "c";
  }

  private isCutKey(event: EngineKeyEvent): boolean {
    return event.kind === "press" && this.clipboardHeld(event) && event.key === "x";
  }

  private focusedInput(): { selectionText(): Promise<string> } | null {
    const browser = this.tabs.activeController;
    if (!browser) return null;
    if (browser.popup) return browser.popup.input;
    if (browser.devtoolsFocused && browser.devtools) return browser.devtools.input;
    return browser;
  }

  private async mirrorSelection(): Promise<boolean> {
    const text = await this.focusedInput()?.selectionText();
    if (!text) return false;
    this.root?.setClipboard(text);
    return true;
  }

  private async copySelection() {
    if (await this.mirrorSelection()) this.showToast("copied to clipboard", "done");
    else if (process.platform === "linux") this.showToast("ctrl+q to quit", "alert");
  }

  private closeOrShutdown(id: number) {
    if (this.tabs.count <= 1) this.shutdown();
    else this.tabs.close(id);
  }

  shutdown(code = 0) {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    ipcMain.removeListener("terminal-browser:theme-request", this.onThemeRequest);
    ipcMain.removeListener("terminal-browser:quit", this.onQuitRequest);
    for (const record of this.records.values()) record.dispose();
    this.records.clear();
    this.shownRecord = null;
    try {
      this.root?.setPointerShape("text");
    } catch { }
    try {
      browserSession(this.sessionPartition()).flushStorageData();
    } catch { }
    this.registry?.dispose();
    this.registry = null;
    this.tabs.stopAll();
    try {
      this.popupSurface?.close();
      this.devtoolsSurface?.close();
    } catch { }
    this.root?.stop();
    this.ctx.onClose(code);
  }

  nudgeResize() {
    this.root?.nudgeResize();
  }

  private themePayload(): {
    background: number[];
    foreground: number[];
    ansi: (number[] | null)[];
  } | null {
    if (!this.root) return null;
    const colors = this.root.info.colors;
    if (!colors.background || !colors.foreground) return null;
    const rgb = (channelled: number[] | null) =>
      channelled ? [channelled[0], channelled[1], channelled[2]] : null;
    return {
      background: rgb(colors.background) as number[],
      foreground: rgb(colors.foreground) as number[],
      ansi: Array.from({ length: 16 }, (_, at) => rgb(colors.palette[at] ?? null)),
    };
  }

  private ownsSender(event: IpcMainEvent): boolean {
    if (event.senderFrame !== event.sender.mainFrame) return false;
    let mine = false;
    this.tabs.eachController((controller) => {
      if (controller.hasContents(event.sender.id)) mine = true;
    });
    return mine;
  }

  private broadcastTheme(): void {
    if (!this.preload && !this.mainScript) return;
    const payload = this.themePayload();
    if (!payload) return;
    this.tabs.eachController((controller) =>
      controller.sendToPage("terminal-browser:theme", payload),
    );
  }

  private installEmbedderApi(): void {
    if (!this.preload && !this.mainScript) return;
    ipcMain.on("terminal-browser:theme-request", this.onThemeRequest);
    ipcMain.on("terminal-browser:quit", this.onQuitRequest);
    this.registerPreloads();
    if (this.mainScript) {
      const file = path.resolve(this.ctx.cwd, this.mainScript);
      try {
        createRequire(file)(file);
      } catch (error) {
        process.stderr.write(
          `main script failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }

  private themeBackground(): string {
    const bg = this.root?.info.colors.background ?? [30, 32, 38, 255];
    return `#${bg.slice(0, 3).map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  }

  private render() {
    if (!this.root || !this.layout || !this.popupSurface) return;
    if (!this.devtoolsSurface) return;
    const pageSurface = this.tabs.activeController?.surface;
    if (!pageSurface) return;
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
            ? { suggestions: this.newTab.suggestions, index: this.newTab.index }
            : null
        }
        urlEdit={this.urlEditOpen}
        popup={this.popupView()}
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
        importHint={this.importHintView()}
        profiles={this.profileMenuView()}
        focusMode={this.noShortcuts}
        dividerEngaged={this.dividerHover || this.dividerDragging}
        record={this.activeRecord()?.view() ?? null}
        recordSurface={this.activeRecord()?.surface ?? null}
        pageSurface={pageSurface}
        popupSurface={this.popupSurface}
        devtoolsSurface={this.devtoolsSurface}
      />,
    );
  }

  private readonly actions: ChromeActions = {
    back: () => this.tabs.activeController?.back(),
    forward: () => this.tabs.activeController?.forward(),
    reload: () => {
      this.activeRecord()?.reloaded();
      this.tabs.activeController?.reload();
    },
    urlEdit: () => this.openUrlEdit(),
    urlEditCancel: () => this.closeUrlEdit(),
    urlSubmit: (text) => {
      this.closeUrlEdit();
      if (text.trim()) this.tabs.activeController?.navigate(searchOrUrl(text, this.ctx.cwd));
    },
    pointer: (event) => {
      this.browserFocused = true;
      this.activeRecord()?.pointerSample(event);
      this.tabs.activeController?.pointer(event);
    },
    wheel: (event) => {
      this.browserFocused = true;
      this.tabs.activeController?.wheel(event);
    },
    pageHover: (hovering) => {
      this.pageHover = hovering;
      this.syncCursor();
    },
    findChange: (text) => this.tabs.activeController?.find(text),
    findNext: (forward) => this.tabs.activeController?.findNext(forward),
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
    newTabQuery: (text) => this.newTabQuery(text),
    newTabSubmit: (text) => {
      this.closeNewTabModal();
      if (text.trim()) this.tabs.create(searchOrUrl(text, this.ctx.cwd));
    },
    newTabCancel: () => this.closeNewTabModal(),
    popupPointer: (event) => this.tabs.activeController?.popup?.input.pointer(event),
    popupWheel: (event) => this.tabs.activeController?.popup?.input.wheel(event),
    popupClose: () => this.tabs.activeController?.popup?.close(),
    popupHover: (hovering) => {
      this.popupHover = hovering;
      this.syncCursor();
    },
    devtoolsPointer: (event) => {
      const browser = this.tabs.activeController;
      if (!browser?.devtools) return;
      this.browserFocused = true;
      browser.focusDevtools();
      browser.devtools.input.pointer(event);
    },
    devtoolsWheel: (event) => {
      const browser = this.tabs.activeController;
      if (!browser?.devtools) return;
      this.browserFocused = true;
      browser.focusDevtools();
      browser.devtools.input.wheel(event);
    },
    devtoolsHover: (hovering) => {
      this.devtoolsHover = hovering;
      this.syncCursor();
    },
    devtoolsDividerHover: (hovering) => {
      this.dividerHover = hovering;
      this.syncCursor();
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
        this.recalculateLayout();
        const now = Date.now();
        if (now - this.dividerResizeAt > 50) {
          this.dividerResizeAt = now;
          this.resizeSplitWindows({ keepFrame: true });
        }
        this.render();
      }
      if (event.phase === "end") {
        this.dividerDragging = false;
        this.saveDevtoolsSettings();
        this.syncDevtoolsLayout({ keepFrame: true });
      }
    },
    pageMenuAction: (id) => this.runPageMenu(id),
    pageMenuClose: () => this.closePageMenu(),
    focusModeToggle: () => this.toggleFocusMode(),
    screenshotPage: () => void this.copyPageScreenshot(),
    devtoolsToggle: () => this.toggleDevtools(),
    importHintToggle: () => this.toggleImportHint(),
    importRun: () => this.importFromHint(),
    profileMenuToggle: () => {
      this.profileMenuOpen = !this.profileMenuOpen;
      this.profilePrompt = null;
      this.profileContext = null;
      this.render();
    },
    profileContext: (slug) => {
      // A profile in use cannot be deleted, so its row has nothing to offer.
      this.profileContext = slug === this.profile?.slug ? null : slug;
      this.render();
    },
    profileDelete: (slug) => {
      this.profileContext = null;
      try {
        deleteProfile(slug);
        this.showToast(`deleted browser profile ${slug}`, "done");
      } catch (error) {
        this.showProfileFailure(error);
      }
      this.render();
    },
    profileSwitch: (slug) => {
      this.profileMenuOpen = false;
      this.profilePrompt = null;
      // Picking the row the pane is already on just closes the menu; only a real move rebuilds.
      if (slug === this.profile?.slug) {
        this.render();
        return;
      }
      this.applyProfileSwitch(slug);
    },
    profileCreate: (name) => {
      if (name === undefined) {
        this.profilePrompt = { kind: "create", text: "" };
        this.render();
        return;
      }
      try {
        // A profile made here is one the operator wants to be on, so move in the same gesture.
        const created = createProfile(name);
        this.profilePrompt = null;
        this.profileMenuOpen = false;
        this.applyProfileSwitch(created.slug);
      } catch (error) {
        this.showProfileFailure(error);
      }
    },
    profileRename: (name) => {
      const current = this.profile;
      if (!current) {
        // A pinned pane has no profile to hide this row, so say why instead of doing nothing.
        this.showProfileFailure(
          new Error(`this browser is pinned to --partition=${this.explicitPartition}`),
        );
        return;
      }
      if (current.builtIn) return;
      if (name === undefined) {
        this.profilePrompt = { kind: "rename", text: current.name };
        this.render();
        return;
      }
      try {
        this.profile = renameProfile(current.slug, name);
        this.profilePrompt = null;
        this.profileMenuOpen = false;
        this.render();
      } catch (error) {
        this.showProfileFailure(error);
      }
    },
    record: this.recordActions(),
  };

  /** the record session lives with its tab; the active tab's session gets the UI and input */
  private activeRecord(): RecordSession | null {
    const controller = this.tabs.activeController;
    return controller ? this.records.get(controller) ?? null : null;
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

  private async startRecording() {
    if (this.recordStarting) return;
    const controller = this.tabs.activeController;
    if (!controller || !this.root || this.records.has(controller)) return;
    const whenActive = (fn: () => void) => () => {
      if (this.tabs.activeController === controller) fn();
    };
    this.recordStarting = true;
    try {
      const session = await RecordSession.create(
        {
          root: this.root,
          layout: () => this.layout,
          canvasRect: () => {
            const surface = this.surfaceLayout!;
            return { x: surface.x, y: surface.y, width: surface.width, height: surface.height };
          },
          page: () => {
            const state = this.tabs.stateFor(controller) ?? this.fallbackState;
            return { url: state.url, title: state.title };
          },
          fontFile: () => bundledFontPath(),
          requestRender: () => this.render(),
          blurToOverlay: whenActive(() => this.blurToOverlay()),
          reviewStarted: whenActive(() => this.syncRecordLayout()),
          refocusPage: whenActive(() => this.refocusPage()),
          setKeyCapture: (keys) => {
            if (keys.length === 0 || this.tabs.activeController === controller) {
              this.root?.setKeyCapture(keys);
            }
          },
          setClipboard: (text) => this.root?.setClipboard(text),
          toast: (name, state, detail) => this.showToast(name, state, detail),
          finished: () => {
            this.records.delete(controller);
            if (this.shownRecord?.controller === controller) this.shownRecord = null;
            this.syncRecordLayout();
          },
        },
        controller,
      );
      this.records.set(controller, session);
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
    this.resizeSplitWindows();
    this.render();
  }

  private handleKey(event: EngineKeyEvent) {
    const browser = this.tabs.activeController;
    if (browser?.popup) {
      if (event.kind !== "release" && event.key === "escape") {
        browser.popup.close();
        return;
      }
      if (!this.noShortcuts && event.kind !== "release" && event.mods.ctrl && event.key === "q") {
        this.shutdown();
        return;
      }
      if (!this.noShortcuts && event.kind !== "release" && this.cmdHeld(event)) {
        const direction = zoomDirection(event.key);
        if (direction !== null) {
          this.applyZoom(direction);
          return;
        }
      }
      if (this.isPasteKey(event)) this.root?.requestClipboardImage();
      if (this.isCopyKey(event)) void this.copySelection();
      if (this.isCutKey(event)) void this.mirrorSelection();
      browser.popup.input.key(event);
      return;
    }
    if (event.kind !== "release") {
      const quitKey =
        event.key === "q" || (process.platform === "darwin" && event.key === "c");
      if (!this.noShortcuts && event.mods.ctrl && quitKey) {
        this.shutdown();
        return;
      }
      if (this.pageMenu) {
        this.closePageMenu();
        if (event.key === "escape") return;
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
        return;
      }
      if (this.newTab) {
        const session = this.newTab;
        const step = listStep(event);
        if (event.key === "escape") this.closeNewTabModal();
        else if (step) {
          const count = session.suggestions.length;
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
          const text = session.index >= 0 ? session.suggestions[session.index] : session.query;
          this.actions.newTabSubmit(text);
        }
        return;
      }
      if (this.urlEditOpen) {
        if (event.key === "escape") this.closeUrlEdit();
        return;
      }
      if (!this.findOpen && this.activeRecord()?.handleKey(event)) return;
      if (!this.noShortcuts) {
        if (isRecordKey(event)) {
          if (!this.activeRecord()) void this.startRecording();
          return;
        }
        if ((this.cmdHeld(event) || event.mods.ctrl) && event.key === "t") {
          if (!this.activeRecord()?.reviewing) this.openNewTabModal();
          return;
        }
        if (matchesBinding(event, this.paletteBinding)) {
          this.openPalette();
          return;
        }
        if (this.accelHeld(event) && event.key === "l") {
          this.openUrlEdit();
          return;
        }
        if (matchesBinding(event, this.findBinding)) {
          this.openFind();
          return;
        }
        if (matchesBinding(event, this.devtoolsBinding) || isPlainKey(event, "f12")) {
          this.toggleDevtools();
          return;
        }
        if (matchesBinding(event, this.consoleBinding)) {
          this.toggleDevtoolsConsole();
          return;
        }
      }
      if (event.key === "escape" && this.findOpen) {
        this.closeFind();
        return;
      }
      if (event.key === "enter" && this.findOpen) {
        browser?.findNext(!event.mods.shift);
        return;
      }
      if (!this.noShortcuts) {
        if (this.accelHeld(event) && event.key === "r") {
          this.activeRecord()?.reloaded();
          browser?.reload();
          return;
        }
        if (this.accelHeld(event) && event.key === "[") {
          browser?.back();
          return;
        }
        if (this.accelHeld(event) && event.key === "]") {
          browser?.forward();
          return;
        }
        if (this.cmdHeld(event)) {
          const direction = zoomDirection(event.key);
          if (direction !== null) {
            this.applyZoom(direction);
            return;
          }
        }
      }
    }
    if (event.kind === "release") {
      this.routeKey(event);
      return;
    }
    if (this.browserFocused) {
      if (this.isPasteKey(event)) this.root?.requestClipboardImage();
      if (this.isCopyKey(event)) void this.copySelection();
      if (this.isCutKey(event)) void this.mirrorSelection();
      this.routeKey(event);
    }
  }

  private routeKey(event: EngineKeyEvent) {
    const browser = this.tabs.activeController;
    if (browser?.devtoolsFocused && browser.devtools) browser.devtools.input.key(event);
    else browser?.key(event);
  }

  private applyZoom(direction: ZoomDirection) {
    const browser = this.tabs.activeController;
    const factor = browser?.popup ? browser.popup.zoom(direction) : browser?.zoom(direction);
    if (factor == null) return;
    this.showZoomHud(factor);
  }

  private followCellZoom() {
    if (!this.root) return;
    const { height, basePx } = this.root.info;
    const prev = this.cellFollow;
    this.cellFollow = { height, basePx };
    if (!prev || !prev.basePx || !prev.height) return;
    const ratio = basePx / prev.basePx;
    if (!Number.isFinite(ratio) || ratio <= 0 || Math.abs(ratio - 1) < 0.01) return;
    const paneRatio = height / prev.height;
    if (Math.abs(paneRatio - ratio) < 0.04 * ratio) return;
    let hud: number | null = null;
    const active = this.tabs.activeController;
    this.tabs.eachController((controller) => {
      const factor = controller.scaleZoom(ratio);
      if (controller === active) hud = factor;
    });
    if (active?.popup) hud = active.popup.scaleZoom(ratio);
    if (hud != null) this.showZoomHud(hud);
  }

  private showZoomHud(factor: number) {
    if (this.noOverlays) return;
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
    if (this.noOverlays) return;
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

  private async runCookieImport(request: CookieImportRequest): Promise<CookieImportResult> {
    if (importingCookies) {
      throw new Error("a cookie import is already running — wait for it to finish");
    }
    importingCookies = true;
    try {
      // An import run from this pane signs this pane's own profile in, unless one was named.
      const result = await importChromeCookies({
        ...request,
        toProfile: request.toProfile ?? this.profile?.slug,
      });
      return { ...result, warnings: cookieImportWarnings(result) };
    } finally {
      importingCookies = false;
    }
  }

  /** One filesystem scan per session: detection walks every supported browser's profile dirs. */
  private loadImportHint() {
    try {
      this.importSummary = cookieSourceSummary(listCookieSources());
    } catch { }
  }

  private importHintView(): ImportHintView {
    return {
      open: this.importHintOpen,
      summary: this.importSummary,
    };
  }

  private toggleImportHint() {
    this.importHintOpen = !this.importHintOpen;
    this.render();
  }


  private importFromHint() {
    this.importHintOpen = false;
    this.importCookies();
    this.render();
  }

  private importCookies() {
    void this.runCookieImport({})
      .then((report) => {
        this.showToast(
          `imported ${report.imported} cookies from ${report.browser} (${report.profileName})`,
          report.warnings.length > 0 ? "alert" : "done",
          report.warnings.join("\n") || undefined,
        );
        this.render();
      })
      .catch((error: unknown) => {
        this.showToast("cookie import failed", "failed", error instanceof Error ? error.message : String(error));
      });
  }

  private sessionPartition(): string | null {
    if (this.explicitPartition) return this.explicitPartition;
    return this.profile ? partitionFor(this.profile.slug) : null;
  }

  /** Preloads are registered per session, so a pane that switches profile needs them again. */
  private registerPreloads(): void {
    if (!this.preload) return;
    const ses = browserSession(this.sessionPartition());
    registerPreloadOnce(ses, apiPreloadPath());
    registerPreloadOnce(ses, path.resolve(this.ctx.cwd, this.preload));
  }

  private profileMenuView(): ProfileMenuView {
    return {
      open: this.profileMenuOpen,
      activeSlug: this.profile?.slug ?? "",
      activeName: this.profile?.name ?? `partition ${this.explicitPartition}`,
      items: listProfiles().map((profile) => ({
        slug: profile.slug,
        name: profile.name,
        active: profile.slug === this.profile?.slug,
      })),
      contextSlug: this.profileContext,
      prompt: this.profilePrompt,
    };
  }

  private profileListing(): ProfileListing {
    return {
      profiles: listProfiles().map((profile) => ({
        ...profile,
        active: profile.slug === this.profile?.slug,
      })),
      activeSlug: this.profile?.slug ?? "",
      activeName: this.profile?.name ?? "",
    };
  }

  private renameBySelector(selector: string, name: string): BrowserProfile {
    const renamed = renameProfile(resolveProfile(selector).slug, name);
    if (this.profile?.slug === renamed.slug) this.profile = renamed;
    this.render();
    return renamed;
  }

  private deleteBySelector(selector: string): BrowserProfile {
    const target = resolveProfile(selector);
    deleteProfile(target.slug);
    this.render();
    return target;
  }

  private async clearBySelector(selector: string): Promise<BrowserProfile> {
    const target = resolveProfile(selector);
    await clearProfileData(target.slug);
    this.render();
    return target;
  }

  /**
   * A view's session is fixed when it is built, so the pane changes profile by replacing its
   * views: capture the urls, drop the old views, flip identity while none exists, build again.
   */
  private switchProfile(selector: string): { profile: BrowserProfile; url: string } {
    if (this.explicitPartition) {
      throw new Error(`this browser is pinned to --partition=${this.explicitPartition}`);
    }
    const target = resolveProfile(selector);
    const url = this.tabs.activeState?.url ?? this.fallbackState.url;
    if (target.slug === this.profile?.slug) {
      noteProfileUsed(target.slug);
      throw new Error(`already on browser profile ${target.slug}`);
    }
    this.findOpen = false;
    this.urlEditOpen = false;
    this.pageMenu = null;
    this.newTab = null;
    for (const record of this.records.values()) record.dispose();
    this.records.clear();
    this.shownRecord = null;
    const carried = this.tabs.teardown();
    this.profile = target;
    noteProfileUsed(target.slug);
    configureBrowserSession(this.sessionPartition(), (progress) => this.showDownload(progress));
    this.registerPreloads();
    this.tabs.restore(carried);
    this.registry?.update();
    this.render();
    return { profile: target, url };
  }

  private applyProfileSwitch(slug: string) {
    try {
      this.switchProfile(slug);
    } catch (error) {
      this.showProfileFailure(error);
    }
  }

  private showProfileFailure(error: unknown) {
    this.showToast(
      "profile failed",
      "failed",
      error instanceof Error ? error.message : String(error),
    );
    this.render();
  }

  private showToast(text: string, state: "done" | "failed" | "alert", detail?: string) {
    if (this.noOverlays) return;
    this.toast = { text, detail, failed: state === "failed", alert: state === "alert" };
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast = null;
      this.toastTimer = null;
      this.render();
    }, 2000);
    this.render();
  }

  // fixme: ghostty doesn't support that cursor type, not sure if any terminals do
  private syncCursor() {
    const browser = this.tabs.activeController;
    const shape = this.activeRecord()?.reviewing
      ? "default"
      : this.dividerHover
        ? this.devtoolsDockSide === "bottom"
          ? "row-resize"
          : "col-resize"
        : this.devtoolsHover
          ? (browser?.devtools?.cursorShape ?? "default")
          : browser?.popup
            ? this.popupHover
              ? browser.popup.cursorShape
              : "default"
            : this.pageHover
              ? (browser?.cursorShape ?? "default")
              : "default";
    if (shape === this.sentCursor) return;
    this.sentCursor = shape;
    this.root?.setPointerShape(shape);
  }

  private blurToOverlay() {
    this.browserFocused = false;
    const browser = this.tabs.activeController;
    this.devtoolsWasFocused = browser?.devtoolsFocused ?? false;
    browser?.blurDevtools();
    browser?.blurContent();
    this.syncCursor();
  }

  private refocusPage() {
    this.browserFocused = true;
    const browser = this.tabs.activeController;
    if (this.devtoolsWasFocused && browser?.devtools) browser.focusDevtools();
    else browser?.focusContent();
    this.syncCursor();
  }

  private toggleFocusMode() {
    this.noShortcuts = !this.noShortcuts;
    this.showToast(
      this.noShortcuts ? "focus mode on — every key goes to the page" : "focus mode off",
      "done",
    );
    this.render();
  }

  private async copyPageScreenshot() {
    const browser = this.tabs.activeController;
    if (!browser) return;
    try {
      await browser.attachCdp();
      const shot = await browser.cdp("Page.captureScreenshot", { format: "png" });
      const encoded = typeof shot.data === "string" ? shot.data : "";
      const image = nativeImage.createFromBuffer(Buffer.from(encoded, "base64"));
      if (image.isEmpty()) throw new Error("the page returned an empty frame");
      clipboard.writeImage(image);
      this.showToast("screenshot copied to clipboard", "done");
    } catch (error) {
      this.showToast(
        "screenshot failed",
        "failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private toggleDevtools() {
    const browser = this.tabs.activeController;
    if (!browser) return;
    if (browser.devtools) browser.closeDevtools();
    else this.openDevtools();
  }

  private openDevtoolsConsole() {
    const browser = this.tabs.activeController;
    if (!browser) return;
    this.openDevtools();
    browser.devtools?.showPanel("console");
    browser.focusDevtools();
  }

  private toggleDevtoolsConsole() {
    const browser = this.tabs.activeController;
    if (!browser) return;
    if (browser.devtools) browser.closeDevtools();
    else this.openDevtoolsConsole();
  }

  private openDevtools() {
    const browser = this.tabs.activeController;
    if (!browser || !this.root || browser.devtools) return;
    this.recalculateLayout({ dock: this.devtoolsDockSide, fraction: this.devtoolsFraction });
    if (this.surfaceLayout) browser.resize(this.surfaceLayout);
    if (this.devtoolsLayout) browser.openDevtools(this.devtoolsLayout, this.devtoolsDockSide);
    browser.focusDevtools();
    this.render();
  }

  private setDevtoolsDockSide(dock: DevtoolsDock) {
    this.rememberDock(dock);
    if (this.tabs.activeController?.devtools) this.syncDevtoolsLayout();
  }

  private rememberDock(dock: DevtoolsDock) {
    if (this.devtoolsDockSide === dock) return;
    this.devtoolsDockSide = dock;
    this.saveDevtoolsSettings();
    this.tabs.eachController((controller) => controller.devtools?.setDock(dock));
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

  private syncDevtoolsLayout(options?: { keepFrame?: boolean }) {
    this.recalculateLayout();
    this.resizeSplitWindows(options);
    this.render();
  }

  private resizeSplitWindows(options?: { keepFrame?: boolean }) {
    const browser = this.tabs.activeController;
    if (this.surfaceLayout) browser?.resize(this.surfaceLayout, options);
    if (this.devtoolsLayout) browser?.devtools?.resize(this.devtoolsLayout, options);
  }

  private openPageMenu(params: Electron.ContextMenuParams) {
    if (this.noContextMenu || !this.surfaceLayout) return;
    if (this.palette || this.newTab || this.urlEditOpen) return;
    if (this.tabs.activeController?.popup) return;
    const scale = this.surfaceLayout.scale;
    this.pageMenu = {
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

  private runPageMenu(id: string) {
    const menu = this.pageMenu;
    this.closePageMenu();
    const browser = this.tabs.activeController;
    if (!menu || !browser) return;
    switch (id) {
      case "copy":
        this.root?.setClipboard(menu.selectionText);
        return;
      case "copy-link":
        this.root?.setClipboard(menu.linkURL);
        return;
      case "inspect":
        this.openDevtools();
        if (browser.devtools) browser.inspect(menu.pageX, menu.pageY);
        return;
      case "record":
        if (this.activeRecord()) this.activeRecord()?.actions.complete();
        else void this.startRecording();
        return;
    }
  }

  private pageMenuView(): PageMenuView | null {
    if (!this.pageMenu) return null;
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
        ? [{ id: "copy-link", label: "copy link address", enabled: true, shortcut: "" }]
        : []),
      ...(this.pageMenu.selectionText || this.pageMenu.linkURL
        ? [{ id: "sep-edit", separator: true } as const]
        : []),
      {
        id: "record",
        label: this.activeRecord() ? "complete recording" : "record",
        enabled: true,
        shortcut: "",
        icon: { d: ICONS.record, tint: "red" as const, weight: 4.5 },
      },
      {
        id: "inspect",
        label: "inspect",
        enabled: true,
        shortcut: bindingLabel(this.devtoolsBinding),
      },
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
    this.newTab = { query: "", suggestions: [], index: -1, seq: 0, timer: null };
    this.blurToOverlay();
    this.root?.setKeyCapture(["enter", "up", "down"]);
    this.render();
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
        if (session.index >= session.suggestions.length) session.index = -1;
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
    this.tabs.activeController?.stopFind();
    this.root?.setKeyCapture([]);
    this.refocusPage();
    this.render();
  }

  private openPalette() {
    if (this.palette) return;
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

  private paletteActions(): PaletteAction[] {
    return [
      {
        id: "import-cookies",
        label: "import cookies (sign in as your everyday browser profile)",
        shortcut: "",
        run: () => this.importCookies(),
      },
      {
        id: "screenshot",
        label: "copy a screenshot of the page to the clipboard",
        shortcut: "",
        run: () => void this.copyPageScreenshot(),
      },
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
      {
        id: "devtools",
        label: this.tabs.activeController?.devtools ? "close devtools" : "open devtools",
        shortcut: bindingLabel(this.devtoolsBinding),
        run: () => this.toggleDevtools(),
      },
      ...(this.tabs.activeController?.devtools
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
    ];
  }

  private filteredPalette(): PaletteAction[] {
    if (!this.palette) return [];
    const query = this.palette.query.toLowerCase();
    return this.paletteActions().filter((action) => action.label.toLowerCase().includes(query));
  }

  private recalculateLayout(placement: DevtoolsPlacement | null = this.devtoolsPlacement()) {
    if (!this.root) return;
    const reviewing = this.activeRecord()?.reviewing ?? false;
    const result = computeLayout(
      this.root.info,
      this.displayScale,
      this.hideToolbar,
      this.noFrame,
      reviewing ? null : placement,
      reviewing ? recordBarHeight(this.root.info) : 0,
    );
    this.layout = result.chrome;
    this.surfaceLayout = result.surface;
    this.devtoolsLayout = result.devtools;
  }

  private devtoolsPlacement(): DevtoolsPlacement | null {
    return this.tabs.activeController?.devtools
      ? { dock: this.devtoolsDockSide, fraction: this.devtoolsFraction }
      : null;
  }

  // this is scary code, popusp in general
  private popupView(): PopupView | null {
    const popup = this.tabs.activeController?.popup;
    if (!popup || !this.layout || !this.surfaceLayout) return null;
    const scale = this.surfaceLayout.scale;
    const headerPx = Math.round(this.layout.rem * 1.7);
    const maxW = Math.round(this.layout.page.width * 0.94);
    const maxH = Math.round(this.layout.page.height * 0.94) - headerPx;
    let host = "";
    try {
      host = new URL(popup.state.url).host;
    } catch { }
    return {
      title: popup.state.title,
      host,
      loading: popup.state.loading,
      width: Math.max(60, Math.min(Math.round(popup.state.width * scale), maxW)),
      height: Math.max(60, Math.min(Math.round(popup.state.height * scale), maxH)),
    };
  }

  private hostDisplayScale() {
    const explicit = Number(this.ctx.env.TERMINAL_BROWSER_DISPLAY_SCALE);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    if (this.terminal?.reportsCssPixels) return 1;
    // this is a bit hacky i would like to improve on it
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).scaleFactor;
  }

  private initialUrl(): string {
    const arg = this.argv.find((argument) => !argument.startsWith("-"));
    if (arg) return arg;
    try {
      const last = lastUrl()?.trim();
      if (last && /^https?:\/\//.test(last)) return last;
    } catch { }
    return DEFAULT_URL;
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

function rememberUrl(url: string) {
  if (!/^https?:\/\//.test(url)) return;
  try {
    setLastUrl(url);
  } catch { }
}

