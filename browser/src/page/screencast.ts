import { nativeImage } from "electron";
import type { Surface } from "pixel-react";

export interface ScreencastTarget {
  cdp(method: string, params?: Record<string, unknown>): Promise<unknown>;
  metrics(): { width: number; height: number; deviceScaleFactor: number; mobile: boolean };
  stopped(): boolean;
}

export class Screencast {
  private readonly surface: Surface;
  private readonly target: ScreencastTarget;
  private queue = Promise.resolve();
  private started = false;
  private configured = false;
  private streaming = false;
  private visible: boolean;

  constructor(surface: Surface, visible: boolean, target: ScreencastTarget) {
    this.surface = surface;
    this.visible = visible;
    this.target = target;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.enqueue();
  }

  setVisible(visible: boolean) {
    if (this.visible === visible) return;
    this.visible = visible;
    if (this.started) this.enqueue();
  }

  reconfigure(): Promise<void> {
    this.configured = false;
    return this.started ? this.enqueue() : Promise.resolve();
  }

  handleFrame(params: unknown) {
    if (this.target.stopped()) return;
    const frame = params as { data: string; sessionId: number };
    try {
      if (this.visible) {
        const image = nativeImage.createFromBuffer(Buffer.from(frame.data, "base64"));
        if (image.isEmpty()) {
          throw new Error("Chromium produced an undecodable screencast frame");
        }
        const { width, height } = image.getSize();
        this.surface.present({ bgra: image.toBitmap(), width, height });
      }
    } catch (error) {
      report(error);
    } finally {
      void this.target
        .cdp("Page.screencastFrameAck", { sessionId: frame.sessionId })
        .catch((error) => {
          if (this.streaming && !this.target.stopped()) report(error);
        });
    }
  }

  private enqueue(): Promise<void> {
    this.queue = this.queue
      .then(() => this.reconcile())
      .catch(report);
    return this.queue;
  }

  private async reconcile() {
    if (this.target.stopped()) return;
    if (!this.configured) {
      await this.setStreaming(false);
      const metrics = this.target.metrics();
      await this.target.cdp("Page.enable");
      await this.target.cdp("Emulation.setDeviceMetricsOverride", {
        width: metrics.width,
        height: metrics.height,
        deviceScaleFactor: metrics.deviceScaleFactor,
        mobile: metrics.mobile,
      });
      this.configured = true;
    }
    if (this.target.stopped()) return;
    await this.setStreaming(this.visible);
  }

  private async setStreaming(streaming: boolean) {
    if (this.streaming === streaming) return;
    if (streaming) {
      const metrics = this.target.metrics();
      await this.target.cdp("Page.startScreencast", {
        format: "png",
        everyNthFrame: 1,
        maxWidth: Math.ceil(metrics.width * metrics.deviceScaleFactor),
        maxHeight: Math.ceil(metrics.height * metrics.deviceScaleFactor),
      });
    } else {
      await this.target.cdp("Page.stopScreencast");
    }
    this.streaming = streaming;
  }
}

function report(error: unknown) {
  const value = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`screencast: ${value}\n`);
}
