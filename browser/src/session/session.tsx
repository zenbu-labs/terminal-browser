import fs from "node:fs";
import path from "node:path";

import { app, clipboard, screen } from "electron";
import { createRoot } from "pixel-react";
import type { EngineKeyEvent, PixelRoot, Surface } from "pixel-react";
import { detectBackend } from "pixel-terminals";
import type { Backend } from "pixel-terminals";

import { configureBrowserSession } from "../page/browser-session";
import type { DownloadProgress } from "../page/browser-session";
import { BrowserController } from "../page/controller";
import { initialBrowserState } from "../page/types";
import type { BrowserState, BrowserSurfaceLayout } from "../page/types";
import { zoomDirection } from "../page/zoom";
import type { ZoomDirection } from "../page/zoom";
import { lastUrl, setLastUrl, settings, store } from "pixel-store";
import type { DevtoolsDock, InstanceRow } from "pixel-store";

import { Registry } from "../registry";
import { Chrome } from "../ui/chrome";
import type {
  ChromeActions,
  ChromeLayout,
  DeviceView,
  DownloadView,
  PageMenuItem,
  PageMenuView,
  PopupView,
} from "../ui/types";
import { normalizeUrl, searchOrUrl } from "../url";
import { bindingGlyphs, matchesBinding, parseKeyBinding } from "./keybindings";
import type { KeyBinding } from "./keybindings";
import { clampDevtoolsFraction, computeLayout, deviceSpec, dividerFraction } from "./layout";
import type { DeviceMode, DevtoolsPlacement } from "./layout";
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

const FONT_FILE = path.join("assets", "fonts", "JetBrainsMono-Regular.ttf");

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

class Session {
  private readonly ctx: SessionContext;
  private readonly backend: Backend | null;
  private readonly tmux: boolean;
  private readonly marker: string;
  private readonly hideToolbar: boolean;
  private readonly partition: string | null;
  private readonly paletteBinding: KeyBinding | null;
  private readonly findBinding: KeyBinding | null;
  private readonly devtoolsBinding: KeyBinding | null;
  private readonly consoleBinding: KeyBinding | null;
  private readonly tabs: TabManager;
  private readonly fallbackState: BrowserState;

  private root: PixelRoot | null = null;
  private pageSurface: Surface | null = null;
  private popupSurface: Surface | null = null;
  private devtoolsSurface: Surface | null = null;
  private registry: Registry | null = null;

  private layout: ChromeLayout | null = null;
  private surfaceLayout: BrowserSurfaceLayout | null = null;
  private devtoolsLayout: BrowserSurfaceLayout | null = null;
  private deviceView: DeviceView | null = null;
  private deviceMode: DeviceMode = "desktop";
  private displayScale = 1;
  private fontId = 0;
  private windowBg = "#1e2026";

  private browserFocused = false;
  private shuttingDown = false;
  private pageHover = false;
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
  private download: DownloadView | null = null;
  private downloadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: SessionContext) {
    this.ctx = ctx;
    this.backend = terminalBackend(ctx.env);
    this.tmux = !!ctx.env.TMUX;
    this.marker = `terminal-browser:${ctx.key}`;
    this.hideToolbar = ctx.argv.includes("--no-toolbar");
    this.partition = flagValue(ctx.argv, "--partition");
    const binding = (flag: string, fallback: string) =>
      parseKeyBinding(flagValue(ctx.argv, flag) ?? defaultBinding(fallback, ctx.env));
    this.paletteBinding = binding("--palette-key", "super+p");
    this.findBinding = binding("--find-key", "super+shift+f");
    // we should use 2 shortcuts for console, also not sure if console actually works as expected
    this.devtoolsBinding = binding("--devtools-key", "super+shift+i");
    this.consoleBinding = binding("--console-key", "super+alt+j");
    this.fallbackState = initialBrowserState(this.initialUrl());
    configureBrowserSession(this.partition, (progress) => this.showDownload(progress));
    this.tabs = new TabManager(
      {
        createController: (url, visible, onState) =>
          new BrowserController(
            this.pageSurface!,
            this.popupSurface!,
            this.devtoolsSurface!,
            this.surfaceLayout!,
            url,
            this.ctx.cwd,
            this.windowBg,
            visible,
            this.partition,
            onState,
            (error) => this.fail(error),
          ),
        deviceSpec: () => deviceSpec(this.deviceMode),
        onActivated: () => {
          this.browserFocused = true;
          this.pageMenu = null;
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
        onTabsChanged: () => this.registry?.update(),
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
    if (!this.ctx.tty) process.stdout.write(`\x1b]2;${this.marker}\x07`);
    this.displayScale = this.hostDisplayScale();
    this.root = createRoot({
      tty: this.ctx.tty,
      tmux: this.tmux,
      keyEventTypes: true,
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
        this.recalculateLayout();
        if (this.surfaceLayout) this.tabs.activeController?.resize(this.surfaceLayout);
        if (this.devtoolsLayout) this.tabs.activeController?.devtools?.resize(this.devtoolsLayout);
        this.render();
      },
      onColors: () => {
        this.windowBg = this.themeBackground();
        this.tabs.eachController((c) => void c.setBackground(this.windowBg));
        this.render();
      },
      onEngineExit: (error) => {
        if (error) process.stderr.write(`terminal-browser engine: ${error}\n`);
        this.shutdown(error ? 1 : 0);
      },
    });
    if (process.platform === "darwin" && !this.root.sharedTextures) {
      throw new Error("terminal-browser requires the patched Electron with shared texture support");
    }
    this.pageSurface = this.root.createSurface();
    this.popupSurface = this.root.createSurface();
    this.devtoolsSurface = this.root.createSurface();
    this.recalculateLayout();
    this.fontId = await this.root.registerFont(bundledFontPath());
    this.root.setPointerShape("default");
    this.windowBg = this.themeBackground();
    this.tabs.create(this.fallbackState.url);
    this.registry = new Registry({
      key: this.ctx.key,
      tty: this.ctx.tty ?? null,
      splitDir: splitDirection(flagValue(this.ctx.argv, "--split-dir")),
      parentTty: flagValue(this.ctx.argv, "--parent-tty"),
      state: () => this.tabs.activeState ?? this.fallbackState,
      openTab: (url, cwd) => this.tabs.create(url ? normalizeUrl(url, cwd) : DEFAULT_URL).id,
      activateTab: (id) => {
        if (!this.tabs.has(id)) return false;
        this.tabs.activate(id);
        return true;
      },
      closeTab: (id) => {
        if (!this.tabs.has(id)) return false;
        this.tabs.close(id);
        return true;
      },
      viewport: () =>
        this.root
          ? {
              width: this.root.info.width,
              height: this.root.info.height,
              scale: this.displayScale,
            }
          : null,
      tabs: () => this.tabs.registryView(),
      targets: () => this.tabs.targets(),
    });
    this.registry.setCdpPort(this.ctx.cdpPort);
    this.render();
  }

  private cmdHeld(event: EngineKeyEvent): boolean {
    return event.mods.super || (this.tmux && event.mods.alt);
  }

  private isPasteKey(event: EngineKeyEvent): boolean {
    return event.kind === "press" && this.cmdHeld(event) && event.key === "v";
  }

  shutdown(code = 0) {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    try {
      this.root?.setPointerShape("text");
    } catch { }
    this.registry?.dispose();
    this.registry = null;
    this.tabs.stopAll();
    try {
      this.pageSurface?.close();
      this.popupSurface?.close();
      this.devtoolsSurface?.close();
    } catch { }
    this.root?.stop();
    this.ctx.onClose(code);
  }

  private fail(error: Error) {
    if (this.shuttingDown) return;
    process.stderr.write(`${error.stack ?? error.message}\n`);
    this.shutdown(1);
  }

  nudgeResize() {
    this.root?.nudgeResize();
  }

  private themeBackground(): string {
    const bg = this.root?.info.colors.background ?? [30, 32, 38, 255];
    return `#${bg.slice(0, 3).map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  }

  private render() {
    if (!this.root || !this.layout || !this.pageSurface || !this.popupSurface) return;
    if (!this.devtoolsSurface) return;
    this.root.render(
      <Chrome
        state={this.tabs.activeState ?? this.fallbackState}
        actions={this.actions}
        layout={this.layout}
        colors={this.root.info.colors}
        font={this.fontId}
        findOpen={this.findOpen}
        device={this.deviceView}
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
        pageSurface={this.pageSurface}
        popupSurface={this.popupSurface}
        devtoolsSurface={this.devtoolsSurface}
      />,
    );
  }

  private readonly actions: ChromeActions = {
    back: () => this.tabs.activeController?.back(),
    forward: () => this.tabs.activeController?.forward(),
    reload: () => this.tabs.activeController?.reload(),
    urlEdit: () => this.openUrlEdit(),
    urlEditCancel: () => this.closeUrlEdit(),
    urlSubmit: (text) => {
      this.closeUrlEdit();
      if (text.trim()) this.tabs.activeController?.navigate(searchOrUrl(text, this.ctx.cwd));
    },
    pointer: (event) => {
      this.browserFocused = true;
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
    tabClose: (id) => (this.tabs.count <= 1 ? this.shutdown() : this.tabs.close(id)),
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
    zoomReset: () => this.applyZoom(0),
  };

  private handleKey(event: EngineKeyEvent) {
    const browser = this.tabs.activeController;
    if (browser?.popup) {
      if (event.kind !== "release" && event.key === "escape") {
        browser.popup.close();
        return;
      }
      if (event.kind !== "release" && event.mods.ctrl && event.key === "q") {
        this.shutdown();
        return;
      }
      if (event.kind !== "release" && this.cmdHeld(event)) {
        const direction = zoomDirection(event.key);
        if (direction !== null) {
          this.applyZoom(direction);
          return;
        }
      }
      if (this.isPasteKey(event)) this.root?.requestClipboardImage();
      browser.popup.input.key(event);
      return;
    }
    if (event.kind !== "release") {
      if (event.mods.ctrl && (event.key === "q" || event.key === "c")) {
        this.shutdown();
        return;
      }
      if (this.pageMenu) {
        this.closePageMenu();
        if (event.key === "escape") return;
      }

      if (this.palette) {
        const down = event.key === "down" || (event.mods.ctrl && event.key === "n");
        const up = event.key === "up" || (event.mods.ctrl && event.key === "p");
        if (event.key === "escape" || matchesBinding(event, this.paletteBinding)) {
          this.closePalette();
        } else if (down || up) {
          const count = this.filteredPalette().length;
          if (count > 0) {
            this.palette.index = (this.palette.index + (down ? 1 : -1) + count) % count;
            this.render();
          }
        } else if (event.key === "enter") this.runPalette();
        return;
      }
      if (this.newTab) {
        const session = this.newTab;
        const down = event.key === "down" || (event.mods.ctrl && event.key === "n");
        const up = event.key === "up" || (event.mods.ctrl && event.key === "p");
        if (event.key === "escape") this.closeNewTabModal();
        else if (down || up) {
          const count = session.suggestions.length;
          if (count > 0) {
            session.index = down
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
      if ((this.cmdHeld(event) || event.mods.ctrl) && event.key === "t") {
        this.openNewTabModal();
        return;
      }
      if (matchesBinding(event, this.paletteBinding)) {
        this.openPalette();
        return;
      }
      if (this.cmdHeld(event) && event.key === "l") {
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
      if (event.key === "escape" && this.findOpen) {
        this.closeFind();
        return;
      }
      if (event.key === "enter" && this.findOpen) {
        browser?.findNext(!event.mods.shift);
        return;
      }
      if (this.cmdHeld(event) && event.key === "r") {
        browser?.reload();
        return;
      }
      if ((event.mods.super || event.mods.ctrl || event.mods.alt) && event.key === "[") {
        browser?.back();
        return;
      }
      if ((event.mods.super || event.mods.ctrl || event.mods.alt) && event.key === "]") {
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
    if (event.kind === "release") {
      this.routeKey(event);
      return;
    }
    if (this.browserFocused) {
      if (this.isPasteKey(event)) this.root?.requestClipboardImage();
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

  // fixme: ghostty doesn't support that cursor type, not sure if any terminals do
  private syncCursor() {
    const browser = this.tabs.activeController;
    const shape = this.dividerHover
      ? this.devtoolsDockSide === "bottom"
        ? "row-resize"
        : "col-resize"
      : this.devtoolsHover
        ? (browser?.devtools?.cursorShape ?? "default")
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
  }

  private refocusPage() {
    this.browserFocused = true;
    const browser = this.tabs.activeController;
    if (this.devtoolsWasFocused && browser?.devtools) browser.focusDevtools();
    else browser?.focusContent();
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
    if (!browser || !this.root || this.deviceMode !== "desktop" || browser.devtools) return;
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
    if (!this.surfaceLayout) return;
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
      case "back":
        browser.back();
        return;
      case "forward":
        browser.forward();
        return;
      case "reload":
        browser.reload();
        return;
      case "copy":
        browser.copySelection();
        return;
      case "copy-link":
        clipboard.writeText(menu.linkURL);
        return;
      case "inspect":
        this.openDevtools();
        if (browser.devtools) browser.inspect(menu.pageX, menu.pageY);
        return;
    }
  }

  private pageMenuView(): PageMenuView | null {
    if (!this.pageMenu) return null;
    const state = this.tabs.activeState;
    const devtoolsShortcut = this.devtoolsBinding
      ? `${bindingGlyphs(this.devtoolsBinding)}${this.devtoolsBinding.key.toUpperCase()}`
      : "";
    const items: PageMenuItem[] = [
      { id: "back", label: "back", enabled: !!state?.canGoBack, shortcut: "⌥[" },
      { id: "forward", label: "forward", enabled: !!state?.canGoForward, shortcut: "⌥]" },
      { id: "reload", label: "reload", enabled: true, shortcut: "⌘R" },
      { id: "sep-nav", separator: true },
      ...(this.pageMenu.selectionText
        ? [{ id: "copy", label: "copy", enabled: true, shortcut: "⌘C" }]
        : []),
      ...(this.pageMenu.linkURL
        ? [{ id: "copy-link", label: "copy link address", enabled: true, shortcut: "" }]
        : []),
      ...(this.pageMenu.selectionText || this.pageMenu.linkURL
        ? [{ id: "sep-edit", separator: true } as const]
        : []),
      {
        id: "inspect",
        label: "inspect",
        enabled: this.deviceMode === "desktop",
        shortcut: devtoolsShortcut,
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

  private async closePaneAndExit() {
    await this.backend?.closePane?.(this.marker).catch(() => false);
    this.shutdown();
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
        id: "find",
        label: "find in page",
        shortcut: `${bindingGlyphs(this.findBinding)}${(this.findBinding?.key ?? "").toUpperCase()}`,
        run: () => this.openFind(),
      },
      {
        id: "zoom-in",
        label: "zoom in",
        shortcut: "⌘+",
        run: () => this.applyZoom(1),
      },
      {
        id: "zoom-out",
        label: "zoom out",
        shortcut: "⌘−",
        run: () => this.applyZoom(-1),
      },
      {
        id: "devtools",
        label: this.tabs.activeController?.devtools ? "close devtools" : "open devtools",
        shortcut: `${bindingGlyphs(this.devtoolsBinding)}${(this.devtoolsBinding?.key ?? "").toUpperCase()}`,
        run: () => this.toggleDevtools(),
      },
      {
        id: "devtools-console",
        label: "open console",
        shortcut: `${bindingGlyphs(this.consoleBinding)}${(this.consoleBinding?.key ?? "").toUpperCase()}`,
        run: () => this.openDevtoolsConsole(),
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
      {
        id: "device-phone",
        label: this.deviceMode === "phone" ? "exit mobile emulation" : "mobile emulation",
        shortcut: "",
        run: () => this.setDeviceMode(this.deviceMode === "phone" ? "desktop" : "phone"),
      },
      {
        id: "device-tablet",
        label: this.deviceMode === "tablet" ? "exit tablet emulation" : "tablet emulation",
        shortcut: "",
        run: () => this.setDeviceMode(this.deviceMode === "tablet" ? "desktop" : "tablet"),
      },
      // ...(this.backend?.zoomPane
      //   ? [
      //     {
      //       id: "zoom-split",
      //       label: "full screen (zoom split)",
      //       shortcut: "⇧⌘↩",
      //       run: () => void this.backend!.zoomPane!(this.marker).catch(() => false),
      //     },
      //   ]
      //   : []),
      ...(this.backend?.closePane
        ? [
          {
            id: "close-pane",
            label: "close pane",
            shortcut: "",
            run: () => void this.closePaneAndExit(),
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

  private setDeviceMode(mode: DeviceMode) {
    if (mode === this.deviceMode) return;
    this.deviceMode = mode;
    if (mode !== "desktop") this.tabs.activeController?.closeDevtools();
    this.recalculateLayout();
    const browser = this.tabs.activeController;
    browser?.setDevice(deviceSpec(mode));
    if (this.surfaceLayout) browser?.resize(this.surfaceLayout);
    this.render();
  }

  private recalculateLayout(placement: DevtoolsPlacement | null = this.devtoolsPlacement()) {
    if (!this.root) return;
    const result = computeLayout(
      this.root.info,
      this.displayScale,
      this.deviceMode,
      this.hideToolbar,
      placement,
    );
    this.layout = result.chrome;
    this.surfaceLayout = result.surface;
    this.devtoolsLayout = result.devtools;
    this.deviceView = result.device;
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

  // stupid
  private hostDisplayScale() {
    const explicit = Number(this.ctx.env.TERMINAL_BROWSER_DISPLAY_SCALE);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    return screen.getPrimaryDisplay().scaleFactor;
  }

  private initialUrl(): string {
    const arg = this.ctx.argv.find((argument) => !argument.startsWith("-"));
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

function defaultBinding(spec: string, env: NodeJS.ProcessEnv): string {
  if (!env.TMUX) return spec;
  const parts = spec.split("+");
  const key = parts.pop()!;
  const mods = [...new Set(parts.map((mod) => (mod === "super" ? "alt" : mod)))];
  return [...mods, key].join("+");
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

function terminalBackend(env: NodeJS.ProcessEnv): Backend | null {
  try {
    return detectBackend(env);
  } catch {
    return null;
  }
}
