import { nativeImage } from "electron";
import type { BrowserWindow } from "electron";
import type { Surface } from "pixel-react";
import { cursorShapeFor } from "./cursor";
import { PageInput } from "./input";
import { clampUserZoom, stepUserZoom } from "./zoom";
import type { ZoomDirection } from "./zoom";

export interface PopupState {
  url: string;
  title: string;
  loading: boolean;
  width: number;
  height: number;
}

export class PopupWindow {
  readonly input: PageInput;
  cursorShape = "default";
  onCursorChange: (() => void) | null = null;
  private readonly window: BrowserWindow;
  private readonly zoomCorrection: () => number;
  private userZoom: number;
  private readonly surface: Surface;
  private readonly onChange: () => void;
  private readonly renderScale: number;
  private stateValue: PopupState;
  private visible = true;
  private focused = false;
  private cdpAttached = false;
  private destroyed = false;

  constructor(
    window: BrowserWindow,
    surface: Surface,
    size: { width: number; height: number },
    renderScale: number,
    scale: () => number,
    zoomCorrection: () => number,
    initialUserZoom: () => number,
    onChange: () => void,
    onClosed: () => void,
    openWindow?: (details: Electron.HandlerDetails) => Electron.WindowOpenHandlerResponse,
  ) {
    this.window = window;
    this.surface = surface;
    this.zoomCorrection = zoomCorrection;
    this.userZoom = initialUserZoom();
    this.onChange = onChange;
    this.renderScale = renderScale;
    this.stateValue = {
      url: window.webContents.getURL(),
      title: "",
      loading: true,
      width: size.width,
      height: size.height,
    };
    this.input = new PageInput({
      contents: () => this.window.webContents,
      scale,
      focus: () => this.focus(),
      cdp: (method, params) => this.cdp(method, params),
    });
    const contents = window.webContents;
    contents.on("page-title-updated", (_event, title) => this.update({ title }));
    contents.on("did-navigate", (_event, url) => {
      this.setUserZoom(this.userZoom);
      this.update({ url });
    });
    contents.on("did-navigate-in-page", (_event, url, mainFrame) => {
      if (mainFrame) this.update({ url });
    });
    contents.on("did-start-loading", () => this.update({ loading: true }));
    contents.on("did-stop-loading", () => this.update({ loading: false }));
    contents.on("cursor-changed", (_event, type) => {
      const shape = cursorShapeFor(type);
      if (shape === this.cursorShape) return;
      this.cursorShape = shape;
      this.onCursorChange?.();
    });
    contents.setWindowOpenHandler(
      openWindow ??
        (({ url }) => {
          void contents.loadURL(url);
          return { action: "deny" };
        }),
    );
    window.on("closed", () => {
      this.destroyed = true;
      this.surface.clear();
      onClosed();
    });
    void this.startStreaming(size, renderScale).catch(() => {});
    this.focus();
  }

  get state(): PopupState {
    return this.stateValue;
  }

  close() {
    if (!this.destroyed) this.window.destroy();
  }

  zoom(direction: ZoomDirection): number {
    return this.setUserZoom(stepUserZoom(this.userZoom, direction));
  }

  scaleZoom(ratio: number): number {
    return this.setUserZoom(clampUserZoom(this.userZoom * ratio));
  }

  /** absolute, for the same reason BrowserController.applyZoom is */
  setUserZoom(value: number): number {
    this.userZoom = value;
    if (this.destroyed) return this.userZoom;
    const want = this.userZoom * this.zoomCorrection();
    const contents = this.window.webContents;
    if (Math.abs(contents.getZoomFactor() - want) > 1e-4) contents.setZoomFactor(want);
    return this.userZoom;
  }

  setVisible(visible: boolean) {
    if (this.visible === visible || this.destroyed) return;
    this.visible = visible;
    void this.cdp(visible ? "Page.startScreencast" : "Page.stopScreencast", {
      ...(visible ? this.screencastParams() : {}),
    }).catch(() => {});
  }

  private screencastParams() {
    return {
      format: "png" as const,
      everyNthFrame: 1,
      maxWidth: Math.ceil(this.stateValue.width * this.renderScale),
      maxHeight: Math.ceil(this.stateValue.height * this.renderScale),
    };
  }

  private async startStreaming(size: { width: number; height: number }, renderScale: number) {
    await this.attachCdp();
    this.window.webContents.debugger.on("message", (_event, method, params) => {
      if (method !== "Page.screencastFrame") return;
      const frame = params as { data: string; sessionId: number };
      void this.cdp("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
      if (!this.visible || this.destroyed) return;
      const image = nativeImage.createFromBuffer(Buffer.from(frame.data, "base64"));
      if (image.isEmpty()) return;
      const dims = image.getSize();
      this.surface.present({ bgra: image.toBitmap(), width: dims.width, height: dims.height });
    });
    await this.cdp("Page.enable");
    await this.cdp("Emulation.setDeviceMetricsOverride", {
      width: size.width,
      height: size.height,
      deviceScaleFactor: renderScale,
      mobile: false,
    });
    await this.cdp("Page.startScreencast", this.screencastParams());
  }

  private focus(): Promise<void> | undefined {
    if (this.focused || this.destroyed) return;
    this.focused = true;
    this.window.focus();
    this.window.webContents.focus();
    return this.cdp("Emulation.setFocusEmulationEnabled", { enabled: true }).then(
      () => undefined,
      () => undefined,
    );
  }

  private async attachCdp() {
    if (this.cdpAttached) return;
    this.window.webContents.debugger.attach("1.3");
    this.cdpAttached = true;
  }

  private async cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
    await this.attachCdp();
    return this.window.webContents.debugger.sendCommand(method, params);
  }

  private update(change: Partial<PopupState>) {
    this.stateValue = { ...this.stateValue, ...change };
    this.onChange();
  }
}
