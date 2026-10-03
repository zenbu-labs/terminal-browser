import { BrowserWindow, screen } from "electron";
import type { EngineKeyEvent, PastedImage, PointerEvent, Surface, WheelEvent } from "../react";
import {
  allowClipboardRead,
  onDownloadFor,
  onMediaCaptureFor,
  onPermissionFor,
  routeThroughProxy,
} from "./browser-session";
import type { DownloadProgress, PermissionGate, PermissionRequest } from "./browser-session";
import { cursorShapeFor } from "./cursor";
import { DevtoolsWindow } from "./devtools";
import { FaviconCache } from "./favicon";
import type { DevtoolsAction } from "./devtools";
import { frameRate, onFrameRateChange } from "./frame-rate";
import { PageInput } from "./input";
import { offscreenPreferences } from "./offscreen";
import { BitmapPresenter, presentPaint } from "./paint";
import { PopupWindow } from "./popup";
import { prepareSession } from "./session";
import { cssSize, initialWebViewState } from "./types";
import type { DevtoolsDock, SurfaceLayout, WebViewState } from "./types";
import { scaleZoom, stepZoom } from "./zoom";
import type { ZoomDirection } from "./zoom";

export const QUIT_URL = "pixel://quit";

export type OpenWindowDecision = "popup" | "deny" | "navigate";
export type OpenWindowPolicy = OpenWindowDecision | ((details: Electron.HandlerDetails) => OpenWindowDecision);

export function defaultOpenWindow(details: Electron.HandlerDetails): OpenWindowDecision {
  return details.disposition === "new-window" ? "popup" : "navigate";
}

export function decideOpenWindow(policy: OpenWindowPolicy | undefined, details: Electron.HandlerDetails) {
  if (typeof policy === "function") return policy(details);
  return policy ?? defaultOpenWindow(details);
}

type ReservedWindowOptions = "width" | "height" | "useContentSize" | "show" | "paintWhenInitiallyHidden" | "webPreferences";
type ReservedWebPreferences = "offscreen" | "disableDialogs" | "backgroundThrottling";
export type BrowserWindowOptions = Omit<Electron.BrowserWindowConstructorOptions, ReservedWindowOptions> & {
  webPreferences?: Omit<Electron.WebPreferences, ReservedWebPreferences>;
};

function windowOptions(
  passthrough: BrowserWindowOptions,
  size: { width: number; height: number },
  offscreen: Electron.WebPreferences["offscreen"],
): Electron.BrowserWindowConstructorOptions {
  const { webPreferences, ...window } = passthrough;
  return {
    frame: false,
    skipTaskbar: true,
    fullscreenable: false,
    resizable: false,
    acceptFirstMouse: true,
    ...window,
    width: size.width,
    height: size.height,
    useContentSize: true,
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      // with sandbox true this is safe, we enable so a users preload script runs inside iframes/webviews
      nodeIntegrationInSubFrames: true,
      contextIsolation: true,
      ...webPreferences,
      offscreen,
      disableDialogs: true,
      backgroundThrottling: false,
    },
  };
}

export interface HostOptions {
  url: string;
  background: string;
  clipboardRead: boolean;
  proxy: string | null;
  browserWindowOptions: BrowserWindowOptions;
}

export class PageHost {
  readonly surface: Surface;
  private readonly popupSurface: Surface;
  private readonly window: BrowserWindow;
  private readonly browserWindowOptions: BrowserWindowOptions;
  private readonly onState: (state: WebViewState) => void;
  private renderScale: number;
  private layout: SurfaceLayout;
  private state: WebViewState;
  private stopped = false;
  private stopWatchingFrameRate?: () => void;
  private contentFocused = false;
  private readonly input: PageInput;
  private readonly clipboardRead: boolean;
  private background: string;
  private pendingPopupSize: { width: number; height: number } | null = null;
  private readonly favicons = new FaviconCache();
  private faviconSeq = 0;
  private findText = "";
  private cdpAttached = false;
  private cdpEventHandlers = new Map<string, (params: unknown) => void>();
  private readonly onDisplayChange = () => {
    if (this.stopped) return;
    this.applyFrameRate();
  };
  private visible = true;
  private framePinned = false;
  private wholeSurfaceNext = true;
  private readonly bitmaps: BitmapPresenter;
  private lastFrameSize: { width: number; height: number } | null = null;
  onFrameSubmitted: (() => void) | null = null;
  cursorShape = "default";
  onCursorChange: ((shape: string) => void) | null = null;
  onOpenWindow: OpenWindowPolicy | null = null;
  onQuit: (() => void) | null = null;
  onDownload: ((progress: DownloadProgress) => void) | null = null;
  onPermission: PermissionGate | null = null;
  private readonly popups: PopupWindow[] = [];
  onPopupChange: (() => void) | null = null;
  get popup(): PopupWindow | null {
    return this.popups[this.popups.length - 1] ?? null;
  }
  devtools: DevtoolsWindow | null = null;
  devtoolsFocused = false;
  onDevtoolsChange: (() => void) | null = null;
  onDevtoolsAction: ((action: DevtoolsAction) => void) | null = null;
  onContextMenu: ((params: Electron.ContextMenuParams) => void) | null = null;
  onClosed: (() => void) | null = null;

  constructor(
    surface: Surface,
    popupSurface: Surface,
    layout: SurfaceLayout,
    options: HostOptions,
    onState: (state: WebViewState) => void,
  ) {
    this.clipboardRead = options.clipboardRead;
    this.browserWindowOptions = options.browserWindowOptions;
    this.surface = surface;
    this.bitmaps = new BitmapPresenter(surface);
    this.popupSurface = popupSurface;
    this.background = options.background;
    this.layout = layout;
    this.onState = onState;
    this.renderScale = renderScaleFor(layout);
    this.state = initialWebViewState(options.url);
    const size = this.contentSize(layout);
    this.window = new BrowserWindow(
      windowOptions(this.browserWindowOptions, size, offscreenPreferences(this.renderScale)),
    );
    prepareSession(this.window.webContents.session);
    if (options.proxy) void routeThroughProxy(this.window.webContents.session, options.proxy);
    if (this.clipboardRead) allowClipboardRead(this.window.webContents);
    onDownloadFor(this.window.webContents, (progress) => this.onDownload?.(progress));
    this.gatePermissions(this.window.webContents);
    onMediaCaptureFor(this.window.webContents, (capturing) => this.updateState({ capturing }));
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
    this.window.on("closed", this.onWindowClosed);
    this.window.webContents.on("will-navigate", (event, url) => {
      if (this.quitLink(url)) event.preventDefault();
    });
    this.stopWatchingFrameRate = onFrameRateChange(this.onDisplayChange);
    screen.on("display-added", this.onDisplayChange);
    screen.on("display-removed", this.onDisplayChange);
    screen.on("display-metrics-changed", this.onDisplayChange);
    this.window.webContents.on("paint", (event, dirtyRect, image) => {
      const shmFrame = event.softwareFrame;
      const size = event.texture
        ? {
            width: event.texture.textureInfo.codedSize.width,
            height: event.texture.textureInfo.codedSize.height,
          }
        : shmFrame
          ? {
              width: shmFrame.frameInfo.contentRect.width,
              height: shmFrame.frameInfo.contentRect.height,
            }
          : image.getSize();
      const presented =
        event.texture || shmFrame
          ? presentPaint(
              this.surface,
              event.texture,
              shmFrame,
              image,
              dirtyRect,
              this.wholeSurfaceNext,
            )
          : this.bitmaps.push(image, dirtyRect, this.wholeSurfaceNext);
      if (!presented) return;
      this.wholeSurfaceNext = false;
      this.lastFrameSize = size;
      this.onFrameSubmitted?.();
    });
    this.window.webContents.on(
      "did-start-navigation",
      (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) this.updateState({ loading: true });
      },
    );
    this.window.webContents.on("did-stop-loading", () => this.updateNavigation(false));
    this.window.webContents.on("did-navigate", (_event, url) => {
      if (urlHost(url) !== urlHost(this.state.url)) this.updateState({ favicon: null });
      this.updateNavigation(this.state.loading, url);
    });
    this.window.webContents.on("did-navigate-in-page", (_event, url, mainFrame) => {
      if (mainFrame) this.updateNavigation(this.state.loading, url);
    });
    this.window.webContents.on("page-favicon-updated", (_event, favicons) => {
      void this.loadFavicon(favicons);
    });
    this.window.webContents.on("page-title-updated", (_event, title) => {
      this.updateState({ title });
    });
    this.window.webContents.on("audio-state-changed", (event) => {
      this.updateState({ audible: event.audible });
    });
    this.window.webContents.on("cursor-changed", (_event, type) => {
      const shape = cursorShapeFor(type);
      if (shape === this.cursorShape) return;
      this.cursorShape = shape;
      this.onCursorChange?.(shape);
    });
    this.window.webContents.on("context-menu", (_event, params) => {
      this.onContextMenu?.(params);
    });
    this.window.webContents.on("found-in-page", (_event, result) => {
      this.updateState({
        findMatches: { active: result.activeMatchOrdinal, total: result.matches },
      });
    });
    this.window.webContents.setWindowOpenHandler((details) =>
      this.handleWindowOpen(details, this.window.webContents),
    );
    this.window.webContents.on("did-create-window", (child) => this.adoptPopup(child));
    void this.window.loadURL(options.url);
    this.onState(this.state);
  }

  get webContents(): Electron.WebContents {
    return this.window.webContents;
  }

  setAudioMuted(muted: boolean) {
    if (this.stopped) return;
    this.window.webContents.setAudioMuted(muted);
    this.updateState({ muted });
  }

  resize(layout: SurfaceLayout, options?: { keepFrame?: boolean }) {
    if (this.stopped) return;
    if (
      this.layout.x === layout.x &&
      this.layout.y === layout.y &&
      this.layout.width === layout.width &&
      this.layout.height === layout.height &&
      this.layout.scale === layout.scale
    ) {
      return;
    }
    const sizeChanged =
      this.layout.width !== layout.width ||
      this.layout.height !== layout.height ||
      this.layout.scale !== layout.scale;
    this.layout = layout;
    this.renderScale = renderScaleFor(layout);
    if (!sizeChanged) return;
    if (!options?.keepFrame) this.surface.clear();
    const size = this.contentSize(layout);
    this.window.setContentSize(size.width, size.height, false);
  }

  navigate(url: string) {
    void this.window.webContents.loadURL(url);
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

  zoom(direction: ZoomDirection): number {
    const factor = stepZoom(this.window.webContents, direction);
    this.updateState({ zoom: factor });
    return factor;
  }

  scaleZoom(ratio: number): number {
    const factor = scaleZoom(this.window.webContents, ratio);
    this.updateState({ zoom: factor });
    return factor;
  }

  async attachCdp(): Promise<void> {
    if (this.cdpAttached) return;
    this.window.webContents.debugger.attach("1.3");
    this.cdpAttached = true;
    this.window.webContents.debugger.on("message", (_event, method, params) => {
      this.cdpEventHandlers.get(method)?.(params);
    });
    await this.cdp("Runtime.enable");
    await this.cdp("Page.enable");
    await this.emulateColorScheme();
  }

  async setBackground(background: string): Promise<void> {
    this.background = background;
    await this.emulateColorScheme();
  }

  private async emulateColorScheme(): Promise<void> {
    if (!this.cdpAttached) return;
    const n = parseInt(this.background.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    const dark = 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
    await this.cdp("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }],
    });
  }

  cdp(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.window.webContents.debugger.sendCommand(method, params) as Promise<
      Record<string, unknown>
    >;
  }

  onCdpEvent(method: string, handler: ((params: unknown) => void) | null) {
    if (handler) this.cdpEventHandlers.set(method, handler);
    else this.cdpEventHandlers.delete(method);
  }

  private applyFrameRate() {
    this.window.webContents.setFrameRate(this.visible || this.framePinned ? frameRate() : 4);
  }

  pinFrameRate(pinned: boolean) {
    if (this.framePinned === pinned || this.stopped) return;
    this.framePinned = pinned;
    this.applyFrameRate();
  }

  frameSize(): { width: number; height: number } | null {
    return this.lastFrameSize;
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

  focusContent(): Promise<void> | undefined {
    if (this.stopped) return;
    this.blurDevtools();
    if (this.contentFocused) return;
    this.window.focus();
    this.window.webContents.focus();
    this.contentFocused = true;
    return this.setFocusEmulation(true).catch(() => {});
  }

  openDevtools(surface: Surface, layout: SurfaceLayout, dock: DevtoolsDock) {
    if (this.devtools || this.stopped) return;
    const devtools = new DevtoolsWindow(
      this.window.webContents,
      surface,
      layout,
      dock,
      this.background,
      this.renderScale,
      (action) => this.onDevtoolsAction?.(action),
      () => {
        if (this.devtools !== devtools) return;
        this.devtools = null;
        this.devtoolsFocused = false;
        this.onDevtoolsChange?.();
      },
    );
    devtools.onCursorChange = () => this.onCursorChange?.(devtools.cursorShape);
    devtools.setVisible(this.visible);
    this.devtools = devtools;
    this.onDevtoolsChange?.();
  }

  closeDevtools() {
    this.devtools?.close();
  }

  focusDevtools() {
    if (this.devtoolsFocused || !this.devtools) return;
    this.blurContent();
    this.devtoolsFocused = true;
    this.devtools.focus();
  }

  blurDevtools() {
    if (!this.devtoolsFocused) return;
    this.devtoolsFocused = false;
    this.devtools?.blur();
  }

  inspect(x: number, y: number) {
    this.window.webContents.inspectElement(Math.round(x), Math.round(y));
  }

  selectionText() {
    return this.input.selectionText();
  }

  blurContent() {
    if (!this.contentFocused) return;
    this.input.releaseKeys();
    this.window.blurWebView();
    this.contentFocused = false;
    void this.setFocusEmulation(false).catch(() => {});
  }

  private async setFocusEmulation(enabled: boolean) {
    await this.attachCdp();
    await this.cdp("Emulation.setFocusEmulationEnabled", { enabled });
  }

  pointer(event: PointerEvent) {
    if (this.stopped) return;
    this.input.pointer(event);
  }

  wheel(event: WheelEvent) {
    if (this.stopped) return;
    this.input.wheel(event);
  }

  key(event: EngineKeyEvent) {
    if (this.stopped) return;
    this.input.key(event);
  }

  sendToPage(channel: string, payload: unknown): void {
    try {
      this.window.webContents.send(channel, payload);
    } catch {}
  }

  hasContents(id: number): boolean {
    return this.window.webContents.id === id;
  }

  paste(text: string) {
    this.input.paste(text);
  }

  pasteImage(image: PastedImage) {
    this.input.pasteImage(image);
  }

  setActive(active: boolean) {
    if (!active) {
      this.blurContent();
      this.input.releaseModifiers();
    }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.teardown();
    this.window.destroy();
  }

  private teardown() {
    for (const popup of [...this.popups]) popup.close();
    this.devtools?.close();
    this.stopWatchingFrameRate?.();
    this.stopWatchingFrameRate = undefined;
    screen.off("display-added", this.onDisplayChange);
    screen.off("display-removed", this.onDisplayChange);
    screen.off("display-metrics-changed", this.onDisplayChange);
    this.surface.close();
  }

  private readonly onWindowClosed = () => {
    if (this.stopped) return;
    this.stopped = true;
    this.teardown();
    this.onClosed?.();
  };

  setVisible(visible: boolean) {
    if (this.stopped) return;
    if (this.visible === visible) return;
    this.visible = visible;
    this.popup?.setVisible(visible);
    this.devtools?.setVisible(visible);
    this.applyFrameRate();
    if (visible) this.window.webContents.invalidate();
  }

  private contentSize(layout: SurfaceLayout) {
    return cssSize(layout.width, layout.height, layout.scale);
  }

  invalidate(): void {
    if (this.stopped) return;
    this.wholeSurfaceNext = true;
    this.window.webContents.invalidate();
  }

  private async loadFavicon(urls: string[]) {
    const seq = ++this.faviconSeq;
    const file = await this.favicons.resolve(urls, this.window.webContents.session).catch(() => null);
    if (file && seq === this.faviconSeq && !this.stopped) this.updateState({ favicon: file });
  }

  private updateNavigation(loading: boolean, url = this.window.webContents.getURL()) {
    this.updateState({
      url,
      loading,
      canGoBack: this.window.webContents.navigationHistory.canGoBack(),
      canGoForward: this.window.webContents.navigationHistory.canGoForward(),
      zoom: this.window.webContents.getZoomFactor(),
    });
  }

  private updateState(update: Partial<WebViewState>) {
    this.state = { ...this.state, ...update };
    this.onState(this.state);
  }

  private quitLink(url: string): boolean {
    if (!url.startsWith(QUIT_URL)) return false;
    setImmediate(() => {
      if (!this.stopped) this.onQuit?.();
    });
    return true;
  }

  private handleWindowOpen(
    details: Electron.HandlerDetails,
    opener: Electron.WebContents,
  ): Electron.WindowOpenHandlerResponse {
    const { url, disposition, features } = details;
    if (this.quitLink(url)) return { action: "deny" };
    const decision = decideOpenWindow(this.onOpenWindow ?? undefined, details);
    if (decision === "deny") return { action: "deny" };
    if (decision === "navigate") {
      void opener.loadURL(url);
      return { action: "deny" };
    }
    const wantsTab = disposition === "foreground-tab" || disposition === "background-tab";
    const size = wantsTab ? this.tabPopupSize() : this.popupSize(features);
    this.pendingPopupSize = size;
    return {
      action: "allow",
      overrideBrowserWindowOptions: windowOptions(this.browserWindowOptions, size, {
        useSharedTexture: false,
        deviceScaleFactor: this.renderScale,
      }),
    };
  }

  private gatePermissions(contents: Electron.WebContents) {
    onPermissionFor(contents, {
      request: (request: PermissionRequest) =>
        this.onPermission ? this.onPermission.request(request) : Promise.resolve(false),
      check: (request: PermissionRequest) => this.onPermission?.check(request) ?? false,
    });
  }

  private adoptPopup(child: Electron.BrowserWindow) {
    if (this.clipboardRead) allowClipboardRead(child.webContents);
    this.gatePermissions(child.webContents);
    const size = this.pendingPopupSize ?? { width: 480, height: 360 };
    this.pendingPopupSize = null;
    child.webContents.on("did-create-window", (grandchild) => this.adoptPopup(grandchild));
    const popup = new PopupWindow(
      child,
      this.popupSurface,
      size,
      this.renderScale,
      () => this.layout.scale,
      () => this.onPopupChange?.(),
      () => {
        const at = this.popups.indexOf(popup);
        if (at < 0) return;
        const wasTop = at === this.popups.length - 1;
        this.popups.splice(at, 1);
        if (wasTop && this.visible) this.popup?.setVisible(true);
        this.onPopupChange?.();
      },
      (details) => this.handleWindowOpen(details, child.webContents),
    );
    popup.onCursorChange = () => {
      if (this.popup === popup) this.onCursorChange?.(popup.cursorShape);
    };
    this.popup?.setVisible(false);
    this.popups.push(popup);
    this.onPopupChange?.();
  }

  private tabPopupSize(): { width: number; height: number } {
    const content = this.contentSize(this.layout);
    return {
      width: Math.max(280, Math.round(content.width * 0.9)),
      height: Math.max(280, Math.round(content.height * 0.9)),
    };
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

function renderScaleFor(layout: SurfaceLayout) {
  const explicit = Number(process.env.PIXEL_RENDER_SCALE);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(0.5, Math.min(layout.scale, explicit));
  }
  const maxPixels = Number(process.env.PIXEL_MAX_PIXELS ?? 0);
  if (!Number.isFinite(maxPixels) || maxPixels <= 0) return layout.scale;
  const cssPixels = layout.width * layout.height / (layout.scale * layout.scale);
  return Math.max(0.5, Math.min(layout.scale, Math.sqrt(maxPixels / cssPixels)));
}

function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
