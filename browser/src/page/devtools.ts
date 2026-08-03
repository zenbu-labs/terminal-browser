import { BrowserWindow, screen } from "electron";
import type { WebContents } from "electron";
import type { Surface } from "pixel-react";
import type { DevtoolsDock } from "pixel-store";
import { cursorShapeFor } from "./cursor";
import { frameRate } from "./frame-rate";
import { PageInput } from "./input";
import { offscreenPreferences } from "./offscreen";
import { presentPaint } from "./paint";
import { cssSize } from "./types";
import type { BrowserSurfaceLayout } from "./types";

export type DevtoolsAction = "close" | "dock-bottom" | "dock-right";

export class DevtoolsWindow {
  readonly input: PageInput;
  private readonly pageContents: WebContents;
  private readonly surface: Surface;
  private readonly window: BrowserWindow;
  private readonly onAction: (action: DevtoolsAction) => void;
  private layout: BrowserSurfaceLayout;
  private dock: DevtoolsDock;
  private visible = true;
  private focused = false;
  private wholeSurfaceNext = true;
  private cdpAttached = false;
  private destroyed = false;
  private pendingPanel: string | null = null;
  cursorShape = "default";
  onCursorChange: ((shape: string) => void) | null = null;
  private readonly onDisplayChange = () => {
    if (this.destroyed) return;
    this.window.webContents.setFrameRate(this.visible ? frameRate() : 4);
  };

  constructor(
    pageContents: WebContents,
    surface: Surface,
    layout: BrowserSurfaceLayout,
    dock: DevtoolsDock,
    background: string,
    renderScale: number,
    onAction: (action: DevtoolsAction) => void,
    onClosed: () => void,
  ) {
    this.pageContents = pageContents;
    this.surface = surface;
    this.layout = layout;
    this.dock = dock;
    this.onAction = onAction;
    this.window = new BrowserWindow({
      ...cssSize(layout.width, layout.height, layout.scale),
      useContentSize: true,
      backgroundColor: background,
      show: false,
      frame: false,
      paintWhenInitiallyHidden: true,
      acceptFirstMouse: true,
      skipTaskbar: true,
      fullscreenable: false,
      resizable: false,
      webPreferences: {
        offscreen: offscreenPreferences(renderScale),
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        disableDialogs: true,
        backgroundThrottling: false,
      },
    });
    this.input = new PageInput({
      contents: () => this.window.webContents,
      scale: () => this.layout.scale,
      focus: () => this.focus(),
      cdp: (method, params) => this.cdp(method, params),
    });
    this.window.webContents.setFrameRate(frameRate());
    screen.on("display-added", this.onDisplayChange);
    screen.on("display-removed", this.onDisplayChange);
    screen.on("display-metrics-changed", this.onDisplayChange);
    this.window.webContents.on("paint", (event, dirtyRect, image) => {
      if (!this.visible) {
        event.texture?.release();
        return;
      }
      if (presentPaint(this.surface, event.texture, image, dirtyRect, this.wholeSurfaceNext)) {
        this.wholeSurfaceNext = false;
      }
    });
    this.window.webContents.on("cursor-changed", (_event, type) => {
      const shape = cursorShapeFor(type);
      if (shape === this.cursorShape) return;
      this.cursorShape = shape;
      this.onCursorChange?.(shape);
    });
    this.window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.window.webContents.on("dom-ready", () => {
      void this.installControls().catch(() => {});
      if (this.pendingPanel) {
        const panel = this.pendingPanel;
        this.pendingPanel = null;
        this.execShowPanel(panel);
      }
    });
    this.window.on("closed", () => {
      this.destroyed = true;
      this.surface.clear();
      onClosed();
    });
    pageContents.setDevToolsWebContents(this.window.webContents);
    pageContents.openDevTools({ mode: "detach" }); // not really detached since we are compositing it into one "window"
  }

  resize(layout: BrowserSurfaceLayout, options?: { keepFrame?: boolean }) {
    if (this.destroyed) return;
    if (
      this.layout.width === layout.width &&
      this.layout.height === layout.height &&
      this.layout.scale === layout.scale
    ) {
      this.layout = layout;
      return;
    }
    this.layout = layout;
    if (!options?.keepFrame) this.surface.clear();
    const size = cssSize(layout.width, layout.height, layout.scale);
    this.window.setContentSize(size.width, size.height, false);
  }

  showPanel(panel: string) {
    if (this.destroyed) return;
    const contents = this.window.webContents;
    if (!contents.getURL().startsWith("devtools://") || contents.isLoading()) {
      this.pendingPanel = panel;
      return;
    }
    this.execShowPanel(panel);
  }

  private execShowPanel(panel: string) {
    const target = JSON.stringify(panel);
    void this.window.webContents
      .executeJavaScript(
        `(function() {
          try { localStorage.setItem("panel-selectedTab", JSON.stringify(${target})); } catch (e) {}
          var tries = 0;
          var timer = setInterval(function() {
            if (window.InspectorFrontendAPI && InspectorFrontendAPI.showPanel) {
              InspectorFrontendAPI.showPanel(${target});
            }
            if (++tries >= 8) clearInterval(timer);
          }, 400);
        })()`,
        true,
      )
      .catch(() => {});
  }

  setDock(dock: DevtoolsDock) {
    if (this.destroyed || this.dock === dock) return;
    this.dock = dock;
    void this.window.webContents
      .executeJavaScript(
        `window.__pixelDevtoolsSetDock && window.__pixelDevtoolsSetDock(${JSON.stringify(dock)})`,
        true,
      )
      .catch(() => {});
  }

  setVisible(visible: boolean) {
    if (this.visible === visible || this.destroyed) return;
    this.visible = visible;
    if (visible) {
      // one surface across every tab's inspector, so its pixels belong to whichever one drew last
      this.wholeSurfaceNext = true;
      this.window.webContents.setFrameRate(frameRate());
      this.window.webContents.invalidate();
    } else {
      this.window.webContents.setFrameRate(4);
    }
  }

  focus() {
    if (this.focused || this.destroyed) return;
    this.focused = true;
    this.window.focus();
    this.window.webContents.focus();
    void this.cdp("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  }

  blur() {
    if (!this.focused || this.destroyed) return;
    this.focused = false;
    this.input.releaseKeys();
    this.window.blurWebView();
    void this.cdp("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
  }

  close() {
    if (this.destroyed) return;
    screen.off("display-added", this.onDisplayChange);
    screen.off("display-removed", this.onDisplayChange);
    screen.off("display-metrics-changed", this.onDisplayChange);
    if (!this.pageContents.isDestroyed()) this.pageContents.closeDevTools();
    this.window.destroy();
  }

  private async installControls() {
    await this.attachCdp();
    await this.window.webContents.executeJavaScript(controlsScript(this.dock), true);
  }

  private async attachCdp() {
    if (this.cdpAttached || this.destroyed) return;
    this.window.webContents.debugger.attach("1.3");
    this.cdpAttached = true;
    this.window.webContents.debugger.on("message", (_event, method, params) => {
      if (method !== "Runtime.bindingCalled") return;
      const call = params as { name: string; payload: string };
      if (call.name !== "__pixelDevtools") return;
      if (call.payload === "close" || call.payload === "dock-bottom" || call.payload === "dock-right") {
        this.onAction(call.payload);
      }
    });
    await this.cdp("Runtime.enable");
    await this.cdp("Runtime.addBinding", { name: "__pixelDevtools" });
  }

  private async cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.destroyed) return undefined;
    await this.attachCdp();
    return this.window.webContents.debugger.sendCommand(method, params);
  }
}

function controlsScript(dock: DevtoolsDock): string {
  return `(function(dock) {
    if (window.__pixelDevtoolsSetDock) { window.__pixelDevtoolsSetDock(dock); return; }
    var ICONS = {
      "dock-bottom": '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor"/><rect x="3.5" y="8.5" width="9" height="3" fill="currentColor"/></svg>',
      "dock-right": '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor"/><rect x="8.5" y="4.5" width="4" height="7" fill="currentColor"/></svg>',
      "close": '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
    };
    var findToolbar = function() {
      // the drawer's tabbed pane can precede the main one in document order;
      // mounting there puts the buttons in the drawer strip instead of the
      // top tab bar
      var panes = document.querySelectorAll(".main-tabbed-pane");
      if (!panes.length) panes = document.querySelectorAll(".tabbed-pane");
      for (var i = 0; i < panes.length; i++) {
        var root = panes[i].shadowRoot;
        var bar = root && root.querySelector(".tabbed-pane-right-toolbar");
        if (bar) return { bar: bar, header: root.querySelector(".tabbed-pane-header") };
      }
      return null;
    };
    var buttons = {};
    var makeButton = function(action) {
      var b = document.createElement("button");
      b.title = action === "close" ? "Close DevTools"
        : action === "dock-bottom" ? "Dock to bottom" : "Dock to right";
      b.style.cssText = "all:unset;box-sizing:border-box;width:24px;height:24px;" +
        "display:flex;align-items:center;justify-content:center;border-radius:4px;" +
        "color:var(--sys-color-on-surface-subtle, #5f6368);";
      b.innerHTML = ICONS[action];
      b.onmouseenter = function() { b.style.background = "var(--sys-color-state-hover-on-subtle, rgba(125,125,125,.15))"; };
      b.onmouseleave = function() { b.style.background = "transparent"; };
      b.onclick = function() { window.__pixelDevtools(action); };
      buttons[action] = b;
      return b;
    };
    var makeHost = function(id, floatCss) {
      var host = document.createElement("div");
      host.id = id;
      host.style.cssText = "display:flex;align-items:center;gap:2px;flex-shrink:0;margin:0 4px;" + floatCss;
      return host;
    };
    var mount = function(found) {
      var dockHost = makeHost("__pixel-devtools-dock", found ? "" : "position:fixed;top:4px;right:132px;z-index:100000;");
      dockHost.appendChild(makeButton("dock-bottom"));
      dockHost.appendChild(makeButton("dock-right"));
      // the close button goes at the end of the header row (the ⚠/gear/⋮
      // icons are siblings of the right toolbar), right-most like the native
      // devtools close
      var closeHost = makeHost("__pixel-devtools-close", found ? "" : "position:fixed;top:4px;right:4px;z-index:100000;");
      closeHost.appendChild(makeButton("close"));
      window.__pixelDevtoolsSetDock = function(d) {
        var active = "var(--sys-color-primary-bright, #1a73e8)";
        var idle = "var(--sys-color-on-surface-subtle, #5f6368)";
        buttons["dock-bottom"].style.color = d === "bottom" ? active : idle;
        buttons["dock-right"].style.color = d === "right" ? active : idle;
      };
      window.__pixelDevtoolsSetDock(dock);
      if (found) {
        found.bar.insertBefore(dockHost, found.bar.firstChild);
        (found.header || found.bar).appendChild(closeHost);
      } else {
        document.documentElement.appendChild(dockHost);
        document.documentElement.appendChild(closeHost);
      }
    };
    var tries = 0;
    var timer = setInterval(function() {
      tries++;
      var found = findToolbar();
      if (found) { clearInterval(timer); mount(found); }
      else if (tries > 20) { clearInterval(timer); mount(null); }
    }, 250);
  })(${JSON.stringify(dock)})`;
}
