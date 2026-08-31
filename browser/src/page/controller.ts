import { BrowserWindow, screen } from "electron";
import type {
  EngineKeyEvent,
  PastedImage,
  PointerEvent,
  Surface,
  WheelEvent,
} from "pixel-react";
import { normalizeUrl, urlHost } from "../url";
import { adblockClosePage, adblockOpenPage, adblockPageNavigated } from "./adblock";
import { allowClipboardRead, persistentPartition } from "./browser-session";
import { cursorShapeFor } from "./cursor";
import { DevtoolsWindow } from "./devtools";
import type { DevtoolsAction } from "./devtools";
import type { DevtoolsDock } from "pixel-store";
import { FaviconCache } from "./favicon";
import { frameRate } from "./frame-rate";
import { PageInput } from "./input";
import { offscreenPreferences } from "./offscreen";
import { BitmapPresenter, presentPaint, shmFrameOf } from "./paint";
import { PopupWindow } from "./popup";
import { cssSize, initialBrowserState } from "./types";
import type { BrowserState, BrowserSurfaceLayout } from "./types";
import { scaleZoom, stepZoom } from "./zoom";
import type { ZoomDirection } from "./zoom";

export interface ControllerOptions {
  cwd: string;
  background: string;
  visible: boolean;
  partition: string | null;
  tabsAsPopups: boolean;
  clipboardRead: boolean;
  adblock: boolean;
  sessionKey: string;
  appTabId: number | null;
}

export class BrowserController {
  readonly surface: Surface;
  private readonly popupSurface: Surface;
  private readonly devtoolsSurface: Surface;
  private readonly window: BrowserWindow;
  private readonly onState: (state: BrowserState) => void;
  private renderScale: number;
  private layout: BrowserSurfaceLayout;
  private state: BrowserState;
  private stopped = false;
  private contentFocused = false;
  private readonly input: PageInput;
  private readonly partition: string | null;
  private readonly tabsAsPopups: boolean;
  private readonly clipboardRead: boolean;
  private readonly adblock: boolean;
  private readonly contentsId: number;
  private readonly sessionKey: string;
  private readonly appTabId: number | null;
  private readonly cwd: string;
  private background: string;
  private pendingPopupSize: { width: number; height: number } | null = null;
  private findText = "";
  private readonly favicons = new FaviconCache();
  private faviconSeq = 0;
  private cdpAttached = false;
  private cachedTargetId: string | null = null;
  private emitHandlers = new Map<string, (data: unknown) => void>();
  private cdpEventHandlers = new Map<string, (params: unknown) => void>();
  private framePinned = false;
  private readonly onDisplayChange = () => {
    if (this.stopped) return;
    this.applyFrameRate();
  };
  private visible = true;
  private wholeSurfaceNext = true;
  private readonly bitmaps: BitmapPresenter;
  private lastFrameSize: { width: number; height: number } | null = null;
  onFrameSubmitted: (() => void) | null = null;
  cursorShape = "default";
  onCursorChange: ((shape: string) => void) | null = null;
  onOpenTab: ((url: string, activate: boolean) => void) | null = null;
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
    devtoolsSurface: Surface,
    layout: BrowserSurfaceLayout,
    initialUrl: string,
    options: ControllerOptions,
    onState: (state: BrowserState) => void,
  ) {
    this.partition = options.partition ? persistentPartition(options.partition) : null;
    this.tabsAsPopups = options.tabsAsPopups;
    this.clipboardRead = options.clipboardRead;
    this.adblock = options.adblock;
    this.sessionKey = options.sessionKey;
    this.appTabId = options.appTabId;
    this.cwd = options.cwd;
    this.surface = surface;
    this.bitmaps = new BitmapPresenter(surface);
    this.popupSurface = popupSurface;
    this.devtoolsSurface = devtoolsSurface;
    this.background = options.background;
    this.visible = options.visible;
    this.layout = layout;
    this.onState = onState;
    this.renderScale = browserRenderScale(layout);
    this.state = initialBrowserState(initialUrl);
    const size = this.contentSize(layout);
    this.window = new BrowserWindow({
      width: size.width,
      height: size.height,
      useContentSize: true,
      show: false,
      frame: false,
      paintWhenInitiallyHidden: true,
      acceptFirstMouse: true,
      skipTaskbar: true,
      fullscreenable: false,
      resizable: false,
      webPreferences: {
        ...(this.partition ? { partition: this.partition } : {}),
        offscreen: offscreenPreferences(this.renderScale),
        sandbox: true,
        nodeIntegration: false,
        // with sandbox true this is safe, we enable so a users preload script runs inside iframes/webviews
        nodeIntegrationInSubFrames: true,
        contextIsolation: true,
        disableDialogs: true,
        backgroundThrottling: false,
        additionalArguments: this.preloadArgv(),
      },
    });
    if (this.clipboardRead) allowClipboardRead(this.window.webContents);
    this.contentsId = this.window.webContents.id;
    adblockOpenPage(this.contentsId, options.adblock, (blocked) => this.updateState({ blocked }));
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
    screen.on("display-added", this.onDisplayChange);
    screen.on("display-removed", this.onDisplayChange);
    screen.on("display-metrics-changed", this.onDisplayChange);
    this.window.webContents.on("paint", (event, dirtyRect, image) => {
      const shmFrame = shmFrameOf(event);
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
      adblockPageNavigated(this.contentsId, urlHost(url));
      this.updateNavigation(this.state.loading, url);
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
    void this.window.loadURL(normalizeUrl(initialUrl, this.cwd));
    this.onState(this.state);
  }

  resize(layout: BrowserSurfaceLayout, options?: { keepFrame?: boolean }) {
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
    this.layout = layout;
    this.renderScale = browserRenderScale(layout);
    // why keep frame?
    if (!options?.keepFrame) this.surface.clear();
    const size = this.contentSize(layout);
    this.window.setContentSize(size.width, size.height, false);
  }

  navigate(value: string) {
    void this.window.webContents.loadURL(normalizeUrl(value, this.cwd));
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

  osPid(): number {
    return this.window.webContents.getOSProcessId();
  }

  async fingerprint(): Promise<number | null> {
    if (this.stopped) return null;
    try {
      await this.attachCdp();
      const result = (await this.cdp("Runtime.evaluate", {
        expression: "performance.timeOrigin",
        returnByValue: true,
      })) as { result?: { value?: number } };
      return typeof result.result?.value === "number" ? result.result.value : null;
    } catch {
      return null;
    }
  }

  async targetId(): Promise<string | null> {
    if (this.cachedTargetId) return this.cachedTargetId;
    if (this.stopped) return null;
    try {
      await this.attachCdp();
      const info = (await this.cdp("Target.getTargetInfo")) as {
        targetInfo?: { targetId?: string };
      };
      this.cachedTargetId = info.targetInfo?.targetId ?? null;
    } catch {
      this.cachedTargetId = null;
    }
    return this.cachedTargetId;
  }

  async attachCdp(): Promise<void> {
    if (this.cdpAttached) return;
    this.window.webContents.debugger.attach("1.3");
    this.cdpAttached = true;
    this.window.webContents.debugger.on("message", (_event, method, params) => {
      this.cdpEventHandlers.get(method)?.(params);
      if (method !== "Runtime.bindingCalled") return;
      const call = params as { name: string; payload: string };
      if (call.name !== "__pixelEmit") return; // eh? 
      try {
        const message = JSON.parse(call.payload) as { channel: string; data: unknown }; // whats going on here
        this.emitHandlers.get(message.channel)?.(message.data);
      } catch {}
    });
    await this.cdp("Runtime.enable");
    await this.cdp("Runtime.addBinding", { name: "__pixelEmit" });
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

  onEmit(channel: string, handler: ((data: unknown) => void) | null) {
    if (handler) this.emitHandlers.set(channel, handler);
    else this.emitHandlers.delete(channel);
  }

  onCdpEvent(method: string, handler: ((params: unknown) => void) | null) {
    if (handler) this.cdpEventHandlers.set(method, handler);
    else this.cdpEventHandlers.delete(method);
  }

  pinFrameRate(pinned: boolean) {
    if (this.framePinned === pinned || this.stopped) return;
    this.framePinned = pinned;
    this.applyFrameRate();
  }

  private applyFrameRate() {
    this.window.webContents.setFrameRate(this.visible || this.framePinned ? frameRate() : 4);
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

  focusContent(): Promise<void> | undefined {
    if (this.stopped) return;
    this.blurDevtools();
    if (this.contentFocused) return;
    this.window.focus();
    /**
     * web contents, oh
     */
    this.window.webContents.focus();
    this.contentFocused = true;
    return this.setFocusEmulation(true).catch(() => {});
  }

  openDevtools(layout: BrowserSurfaceLayout, dock: DevtoolsDock) {
    if (this.devtools) return;
    const devtools = new DevtoolsWindow(
      this.window.webContents,
      this.devtoolsSurface,
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
    adblockClosePage(this.contentsId);
    for (const popup of [...this.popups]) popup.close();
    this.devtools?.close();
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

  private preloadArgv(): string[] {
    const argv = [`--terminal-browser-session=${this.sessionKey}`];
    if (this.appTabId != null) argv.push(`--terminal-browser-app-tab=${this.appTabId}`);
    return argv;
  }

  private contentSize(layout: BrowserSurfaceLayout) {
    return cssSize(layout.width, layout.height, layout.scale);
  }

  frameSize(): { width: number; height: number } | null {
    return this.lastFrameSize;
  }

  invalidate(): void {
    if (this.stopped) return;
    this.wholeSurfaceNext = true;
    this.window.webContents.invalidate();
  }

  private async loadFavicon(urls: string[]) {
    const seq = ++this.faviconSeq;
    const file = await this.favicons
      .resolve(urls, this.window.webContents.session)
      .catch(() => null);
    if (file && seq === this.faviconSeq) this.updateState({ favicon: file });
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

  private updateState(update: Partial<BrowserState>) {
    this.state = { ...this.state, ...update };
    this.onState(this.state);
  }

  private quitLink(url: string): boolean {
    if (!url.startsWith("terminal-browser://quit")) return false;
    setImmediate(() => {
      if (!this.stopped) this.window.close();
    });
    return true;
  }

  private handleWindowOpen(
    { url, disposition, features }: Electron.HandlerDetails,
    opener: Electron.WebContents,
  ): Electron.WindowOpenHandlerResponse {
    if (this.quitLink(url)) return { action: "deny" };
    const wantsTab = disposition === "foreground-tab" || disposition === "background-tab";
    if (wantsTab && !this.tabsAsPopups && this.onOpenTab) {
      this.onOpenTab(url, disposition === "foreground-tab");
      return { action: "deny" };
    }
    if (disposition === "new-window" || (wantsTab && this.tabsAsPopups)) {
      const size = wantsTab ? this.tabPopupSize() : this.popupSize(features);
      this.pendingPopupSize = size;
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: size.width,
          height: size.height,
          useContentSize: true,
          show: false,
          frame: false,
          skipTaskbar: true,
          fullscreenable: false,
          resizable: false,
          webPreferences: {
            ...(this.partition ? { partition: this.partition } : {}),
            offscreen: { useSharedTexture: false, deviceScaleFactor: this.renderScale },
            sandbox: true,
            nodeIntegration: false,
            nodeIntegrationInSubFrames: true,
            contextIsolation: true,
            disableDialogs: true,
            backgroundThrottling: false,
            additionalArguments: this.preloadArgv(),
          },
        },
      };
    }
    void opener.loadURL(url);
    return { action: "deny" };
  }

  private adoptPopup(child: Electron.BrowserWindow) {
    if (this.clipboardRead) allowClipboardRead(child.webContents);
    const popupContents = child.webContents.id;
    adblockOpenPage(popupContents, this.adblock);
    child.webContents.on("did-navigate", (_event, url) =>
      adblockPageNavigated(popupContents, urlHost(url)),
    );
    child.webContents.once("destroyed", () => adblockClosePage(popupContents));
    if (!this.tabsAsPopups) this.popup?.close();
    const size = this.pendingPopupSize ?? { width: 480, height: 360 };
    this.pendingPopupSize = null;
    if (this.tabsAsPopups) {
      child.webContents.on("did-create-window", (grandchild) => this.adoptPopup(grandchild));
    }
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
      this.tabsAsPopups
        ? (details) => this.handleWindowOpen(details, child.webContents)
        : undefined,
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

function browserRenderScale(layout: BrowserSurfaceLayout) {
  const explicit = Number(process.env.TERMINAL_BROWSER_RENDER_SCALE);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(0.5, Math.min(layout.scale, explicit));
  }
  const maxPixels = Number(process.env.TERMINAL_BROWSER_MAX_PIXELS ?? 0);
  if (!Number.isFinite(maxPixels) || maxPixels <= 0) return layout.scale;
  const cssPixels = layout.width * layout.height / (layout.scale * layout.scale);
  return Math.max(0.5, Math.min(layout.scale, Math.sqrt(maxPixels / cssPixels)));
}

