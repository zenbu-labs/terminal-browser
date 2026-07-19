import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BrowserWindow, net, nativeImage, screen } from "electron";
import type { OffscreenSharedTexture } from "electron";
import type {
  EngineKeyEvent,
  PointerEvent,
  Surface,
  WheelEvent,
} from "pixel-react";
import { FramePerf } from "./perf";
import type { BrowserState } from "./chrome";
import { PageInput } from "./input";
import { PopupWindow } from "./popup";

export interface BrowserSurfaceLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

export interface DeviceSpec {
  width: number;
  height: number;
  userAgent: string;
}

export class BrowserController {
  private readonly surface: Surface;
  private readonly popupSurface: Surface;
  private readonly window: BrowserWindow;
  private readonly onState: (state: BrowserState) => void;
  private readonly renderScale: number;
  private layout: BrowserSurfaceLayout;
  private state: BrowserState;
  private stopped = false;
  private contentFocused = false;
  private readonly input: PageInput;
  private readonly partition: string | null;
  private pendingPopupSize: { width: number; height: number } | null = null;
  private findText = "";
  private faviconSeq = 0;
  private cdpAttached = false;
  private emitHandlers = new Map<string, (data: unknown) => void>();
  private device: DeviceSpec | null = null;
  private defaultUserAgent = "";
  private readonly onDisplayChange = () => {
    if (this.stopped) return;
    this.window.webContents.setFrameRate(this.visible ? frameRate() : 4);
  };
  readonly perf = new FramePerf();
  private captureSkews: number[] = [];

  /** chromium stamps textures with microseconds on its own clock; the
   * minimum skew against our clock over a recent window turns that into a
   * relative delivery latency. Windowed, not all-time: the capturer restarts
   * (and resets its clock) whenever the view is hidden and shown again. */
  private captureLatency(timestampUs: number): number | null {
    if (!Number.isFinite(timestampUs)) return null;
    const skew = performance.now() - timestampUs / 1000;
    this.captureSkews.push(skew);
    if (this.captureSkews.length > 240) this.captureSkews.shift();
    return skew - Math.min(...this.captureSkews);
  }
  private visible = true;
  cursorShape = "default";
  onCursorChange: ((shape: string) => void) | null = null;
  onOpenTab: ((url: string, activate: boolean) => void) | null = null;
  popup: PopupWindow | null = null;
  onPopupChange: (() => void) | null = null;

  constructor(
    surface: Surface,
    popupSurface: Surface,
    layout: BrowserSurfaceLayout,
    initialUrl: string,
    background: string,
    visible: boolean,
    // tools like `pixel code` isolate their page storage from other panes;
    // chromium hangs IndexedDB opens when sessions share a partition
    partition: string | null,
    onState: (state: BrowserState) => void,
  ) {
    this.partition = partition;
    this.surface = surface;
    this.popupSurface = popupSurface;
    this.visible = visible;
    this.layout = layout;
    this.onState = onState;
    this.renderScale = browserRenderScale(layout);
    this.state = {
      url: initialUrl,
      title: "",
      favicon: null,
      loading: true,
      canGoBack: false,
      canGoForward: false,
      findMatches: null,
    };
    const size = this.contentSize(layout);
    this.window = new BrowserWindow({
      width: size.width,
      height: size.height,
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
        ...(partition ? { partition } : {}),
        offscreen: {
          useSharedTexture: true,
          sharedTexturePixelFormat: "argb",
          deviceScaleFactor: this.renderScale,
        },
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
      focus: () => this.focusContent(),
      cdp: async (method, params) => {
        await this.attachCdp();
        return this.cdp(method, params);
      },
    });
    this.window.webContents.setFrameRate(frameRate());
    // when monitors change, re-apply the rate: chromium rebinds the
    // window's vsync display inside setFrameRate (our electron patch) and
    // frameRate() re-reads the new fastest display
    screen.on("display-added", this.onDisplayChange);
    screen.on("display-removed", this.onDisplayChange);
    screen.on("display-metrics-changed", this.onDisplayChange);
    this.defaultUserAgent = this.window.webContents.getUserAgent();
    this.window.webContents.on("paint", (event, dirty) => {
      const texture = event.texture;
      if (!texture) return;
      if (!this.visible) {
        texture.release();
        return;
      }
      if (!this.perf.running) {
        this.submitTexture(texture);
        return;
      }
      const captureToPaintMs = this.captureLatency(texture.textureInfo.timestamp);
      const size = this.contentSize(this.layout);
      const started = performance.now();
      this.submitTexture(texture);
      this.perf.frame({
        captureToPaintMs,
        consumeMs: performance.now() - started,
        dirtyFraction: Math.min(
          1,
          (dirty.width * dirty.height) / Math.max(1, size.width * size.height),
        ),
      });
    });
    this.window.webContents.on("did-start-loading", () => this.updateState({ loading: true }));
    this.window.webContents.on("did-stop-loading", () => this.updateNavigation(false));
    this.window.webContents.on("did-navigate", (_event, url) => {
      // same-site navigations keep the favicon: chromium only re-emits
      // page-favicodated when the candidate urls actually change
      if (urlHost(url) !== urlHost(this.state.url)) this.updateState({ favicon: null });
      this.updateNavigation(false, url);
    });
    this.window.webContents.on("page-favicon-updated", (_event, favicons) => {
      void this.loadFavicon(favicons);
    });
    this.window.webContents.on("did-navigate-in-page", (_event, url, mainFrame) => {
      if (mainFrame) this.updateNavigation(this.state.loading, url);
    });
    this.window.webContents.on("page-title-updated", (_event, title) => {
      this.updateState({ title });
    });
    this.window.webContents.on("cursor-changed", (_event, type) => {
      const shape = cursorShapeFor(type);
      if (shape === this.cursorShape) return;
      this.cursorShape = shape;
      this.onCursorChange?.(shape);
    });
    this.window.webContents.on("found-in-page", (_event, result) => {
      this.updateState({
        findMatches: { active: result.activeMatchOrdinal, total: result.matches },
      });
    });
    this.window.webContents.setWindowOpenHandler(({ url, disposition, features }) => {
      const wantsTab = disposition === "foreground-tab" || disposition === "background-tab";
      if (wantsTab && this.onOpenTab) {
        this.onOpenTab(url, disposition === "foreground-tab");
        return { action: "deny" };
      }
      if (disposition === "new-window") {
        const size = this.popupSize(features);
        this.pendingPopupSize = size;
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            width: size.width,
            height: size.height,
            useContentSize: true,
            show: false,
            frame: false,
            backgroundColor: background,
            skipTaskbar: true,
            fullscreenable: false,
            resizable: false,
            webPreferences: {
              ...(this.partition ? { partition: this.partition } : {}),
              offscreen: { useSharedTexture: false, deviceScaleFactor: this.renderScale },
              sandbox: true,
              nodeIntegration: false,
              contextIsolation: true,
              disableDialogs: true,
              backgroundThrottling: false,
            },
          },
        };
      }
      void this.window.webContents.loadURL(url);
      return { action: "deny" };
    });
    this.window.webContents.on("did-create-window", (child) => this.adoptPopup(child));
    void this.window.loadURL(normalizeUrl(initialUrl));
    this.onState(this.state);
  }

  resize(layout: BrowserSurfaceLayout) {
    if (
      this.layout.x === layout.x &&
      this.layout.y === layout.y &&
      this.layout.width === layout.width &&
      this.layout.height === layout.height &&
      this.layout.scale === layout.scale
    ) {
      return;
    }
    this.layout = layout;
    this.surface.clear();
    const size = this.contentSize(layout);
    this.window.setContentSize(size.width, size.height, false);
  }

  navigate(value: string) {
    void this.window.webContents.loadURL(normalizeUrl(value));
  }

  back() {
    if (this.window.webContents.navigationHistory.canGoBack()) {
      this.window.webContents.navigationHistory.goBack();
    }
  }

  forward() {
    if (this.window.webContents.navigationHistory.canGoForward()) {
      this.window.webContents.navigationHistory.goForward();
    }
  }

  reload() {
    if (this.state.loading) this.window.webContents.stop();
    else this.window.webContents.reload();
  }

  osPid(): number {
    return this.window.webContents.getOSProcessId();
  }

  async attachCdp(): Promise<void> {
    if (this.cdpAttached) return;
    this.window.webContents.debugger.attach("1.3");
    this.cdpAttached = true;
    this.window.webContents.debugger.on("message", (_event, method, params) => {
      if (method !== "Runtime.bindingCalled") return;
      const call = params as { name: string; payload: string };
      if (call.name !== "__pixelEmit") return;
      try {
        const message = JSON.parse(call.payload) as { channel: string; data: unknown };
        this.emitHandlers.get(message.channel)?.(message.data);
      } catch {}
    });
    await this.cdp("Runtime.enable");
    await this.cdp("Runtime.addBinding", { name: "__pixelEmit" });
    await this.cdp("Page.enable");
  }

  cdp(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.window.webContents.debugger.sendCommand(method, params) as Promise<
      Record<string, unknown>
    >;
  }

  onEmit(channel: string, handler: ((data: unknown) => void) | null) {
    if (handler) this.emitHandlers.set(channel, handler);
    else this.emitHandlers.delete(channel);
  }

  runJs(source: string): Promise<unknown> {
    return this.window.webContents.executeJavaScript(source, true);
  }

  find(text: string) {
    this.findText = text;
    if (!text) {
      this.stopFind();
      return;
    }
    this.window.webContents.findInPage(text);
  }

  findNext(forward: boolean) {
    if (!this.findText) return;
    this.window.webContents.findInPage(this.findText, { forward, findNext: true });
  }

  stopFind() {
    this.findText = "";
    this.window.webContents.stopFindInPage("clearSelection");
    this.updateState({ findMatches: null });
  }

  focusContent() {
    if (this.contentFocused) return;
    this.window.focus();
    this.window.webContents.focus();
    this.contentFocused = true;
    void this.setFocusEmulation(true).catch(() => {});
  }

  blurContent() {
    if (!this.contentFocused) return;
    this.input.releaseKeys();
    this.window.blurWebView();
    this.contentFocused = false;
    void this.setFocusEmulation(false).catch(() => {});
  }

  // the offscreen window is never OS-focused, and chromium's renderer skips
  // painting the text caret in unfocused windows; focus emulation makes the
  // renderer treat the page as focused so the caret draws and blinks
  private async setFocusEmulation(enabled: boolean) {
    await this.attachCdp();
    await this.cdp("Emulation.setFocusEmulationEnabled", { enabled });
  }

  pointer(event: PointerEvent) {
    this.input.pointer(event);
  }

  wheel(event: WheelEvent) {
    this.input.wheel(event);
  }

  key(event: EngineKeyEvent) {
    this.input.key(event);
  }

  paste(text: string) {
    this.input.paste(text);
  }

  setActive(active: boolean) {
    if (!active) this.blurContent();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.popup?.close();
    this.perf.stop();
    screen.off("display-added", this.onDisplayChange);
    screen.off("display-removed", this.onDisplayChange);
    screen.off("display-metrics-changed", this.onDisplayChange);
    if (this.visible) this.surface.clear();
    this.window.destroy();
  }

  setVisible(visible: boolean) {
    if (this.visible === visible) return;
    this.visible = visible;
    this.popup?.setVisible(visible);
    if (visible) {
      this.window.webContents.setFrameRate(frameRate());
      this.window.webContents.invalidate();
    } else {
      this.window.webContents.setFrameRate(4);
    }
  }

  private contentSize(layout: BrowserSurfaceLayout) {
    if (this.device) return { width: this.device.width, height: this.device.height };
    return {
      width: Math.max(1, Math.round(layout.width / layout.scale)),
      height: Math.max(1, Math.round(layout.height / layout.scale)),
    };
  }

  setDevice(spec: DeviceSpec | null) {
    if (spec?.userAgent === this.device?.userAgent) return;
    this.device = spec;
    this.surface.clear();
    const size = this.contentSize(this.layout);
    this.window.setContentSize(size.width, size.height, false);
    if (spec) {
      this.window.webContents.setUserAgent(spec.userAgent);
      this.window.webContents.enableDeviceEmulation({
        screenPosition: "mobile",
        screenSize: { width: spec.width, height: spec.height },
        viewSize: { width: spec.width, height: spec.height },
        viewPosition: { x: 0, y: 0 },
        deviceScaleFactor: 0,
        scale: 1,
      });
    } else {
      this.window.webContents.disableDeviceEmulation();
      this.window.webContents.setUserAgent(this.defaultUserAgent);
    }
    this.window.webContents.reload();
  }

  private submitTexture(texture: OffscreenSharedTexture) {
    try {
      const info = texture.textureInfo;
      const handle = info.handle.ioSurface;
      if (info.widgetType !== "frame" || info.pixelFormat !== "bgra" || !handle) return;
      this.surface.present({ ioSurface: handle });
    } finally {
      texture.release();
    }
  }

  /** Fetch the page's favicon into a local file the engine can decode. The
   * bytes go through nativeImage when possible (png output); formats it can't
   * read (ico, svg) are written raw for the engine's decoder to try. */
  private async loadFavicon(urls: string[]) {
    const url = urls.find((u) => /\.(png|jpe?g|webp)(\?|$)/i.test(u)) ?? urls[0];
    if (!url) return;
    const seq = ++this.faviconSeq;
    const dir = path.join(os.homedir(), ".pixel-browser", "favicons");
    const stem = path.join(dir, crypto.createHash("sha1").update(url).digest("hex").slice(0, 16));
    try {
      const cached = [`${stem}.png`, `${stem}.ico`].find((file) => fs.existsSync(file));
      if (cached) {
        if (seq === this.faviconSeq) this.updateState({ favicon: cached });
        return;
      }
      const response = await net.fetch(url);
      if (!response.ok) return;
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length === 0) return;
      fs.mkdirSync(dir, { recursive: true });
      const decoded = nativeImage.createFromBuffer(data);
      const file = decoded.isEmpty() ? `${stem}.ico` : `${stem}.png`;
      await fs.promises.writeFile(
        file,
        decoded.isEmpty() ? data : decoded.resize({ width: 32, height: 32 }).toPNG(),
      );
      if (seq === this.faviconSeq) this.updateState({ favicon: file });
    } catch {}
  }

  private updateNavigation(loading: boolean, url = this.window.webContents.getURL()) {
    this.updateState({
      url,
      loading,
      canGoBack: this.window.webContents.navigationHistory.canGoBack(),
      canGoForward: this.window.webContents.navigationHistory.canGoForward(),
    });
  }

  private updateState(update: Partial<BrowserState>) {
    this.state = { ...this.state, ...update };
    this.onState(this.state);
  }

  private adoptPopup(child: Electron.BrowserWindow) {
    this.popup?.close();
    const size = this.pendingPopupSize ?? { width: 480, height: 360 };
    this.pendingPopupSize = null;
    const popup = new PopupWindow(
      child,
      this.popupSurface,
      size,
      this.renderScale,
      () => this.layout.scale,
      () => this.onPopupChange?.(),
      () => {
        if (this.popup === popup) this.popup = null;
        this.onPopupChange?.();
      },
    );
    this.popup = popup;
    this.onPopupChange?.();
  }

  private popupSize(features: string): { width: number; height: number } {
    const requested = (name: string) => {
      const match = features.match(new RegExp(`${name}=(\\d+)`));
      return match ? Number(match[1]) : 0;
    };
    const content = this.contentSize(this.layout);
    const clamp = (value: number, fallback: number, max: number) =>
      Math.max(280, Math.min(value || fallback, max));
    return {
      width: clamp(requested("width"), Math.round(content.width * 0.62), Math.round(content.width * 0.85)),
      height: clamp(requested("height"), Math.round(content.height * 0.68), Math.round(content.height * 0.8)),
    };
  }
}

// Requested begin-frame rate for the offscreen window: the fastest connected
// display, since ghostty can't show more than that. Relies on our patched
// electron (zenbu-labs/electron-releases), which drives offscreen begin
// frames from a real display link — stock electron pins offscreen pages to
// 60fps once they receive any input.
function frameRate() {
  const configured = Number(process.env.PIXEL_BROWSER_FPS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(1, Math.min(240, Math.round(configured)));
  }
  const fastest = Math.max(
    0,
    ...screen.getAllDisplays().map((display) => display.displayFrequency),
  );
  return fastest > 0 ? Math.min(240, Math.round(fastest)) : 60;
}

function browserRenderScale(layout: BrowserSurfaceLayout) {
  const explicit = Number(process.env.PIXEL_BROWSER_RENDER_SCALE);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(0.5, Math.min(layout.scale, explicit));
  }
  const maxPixels = Number(process.env.PIXEL_BROWSER_MAX_PIXELS ?? 0);
  if (!Number.isFinite(maxPixels) || maxPixels <= 0) return layout.scale;
  const cssPixels = layout.width * layout.height / (layout.scale * layout.scale);
  return Math.max(0.5, Math.min(layout.scale, Math.sqrt(maxPixels / cssPixels)));
}

/** chromium cursor types that map straight to the CSS shape names terminals
 * accept via OSC 22 (kitty pointer-shape protocol; ghostty parses the same
 * names) */
const CSS_CURSORS = new Set([
  "default", "crosshair", "text", "wait", "help", "progress",
  "cell", "vertical-text", "context-menu", "alias", "copy", "move",
  "no-drop", "not-allowed", "grab", "grabbing", "zoom-in", "zoom-out",
  "e-resize", "n-resize", "ne-resize", "nw-resize", "s-resize", "se-resize",
  "sw-resize", "w-resize", "ns-resize", "ew-resize", "nesw-resize",
  "nwse-resize", "col-resize", "row-resize",
]);

function cursorShapeFor(type: string): string {
  // chromium's "pointer" is the plain arrow; its css pointer is "hand"
  if (type === "hand") return "pointer";
  if (CSS_CURSORS.has(type)) return type;
  if (type === "nodrop") return "no-drop";
  if (type.endsWith("-panning")) return "all-scroll";
  // pointer, custom, none, null, …
  return "default";
}

function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function normalizeUrl(value: string) {
  const input = value.trim();
  if (!input) return "about:blank";
  try {
    return new URL(input).toString();
  } catch {}
  if (/^[\w.-]+(?::\d+)?(?:\/.*)?$/.test(input)) {
    const host = input.split(/[:/]/)[0].toLowerCase();
    const scheme = host === "localhost" || host === "127.0.0.1" ? "http" : "https";
    return new URL(`${scheme}://${input}`).toString();
  }
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}
