import type { NativeBinding } from "@zenbu-labs/pixel/binding";
import type { NativeEngine } from "@zenbu-labs/pixel/device";

import { Pixel } from "./native-module";

function call<T>(name: string, ...args: unknown[]): T {
  const result = JSON.parse(Pixel.call(name, JSON.stringify(args))) as { ok?: T; error?: string };
  if (result.error) throw new Error(result.error);
  return result.ok as T;
}

function unsupported(what: string): never {
  throw new Error(`${what} is not available on iOS`);
}

class DeviceEngine implements NativeEngine {
  private subscription: { remove(): void } | null = null;

  info() {
    return Pixel.info();
  }

  applyOps(ops: string) {
    Pixel.applyOps(ops);
  }

  start(callback: (err: unknown, event: string) => void) {
    this.subscription = Pixel.addListener("onEngineEvents", ({ events }) => {
      for (const event of events) callback(null, event);
    });
    Pixel.start();
  }

  stop() {
    this.subscription?.remove();
    this.subscription = null;
    Pixel.stop();
  }

  setKeyEventTypes() {}

  updateSurface(): void {
    unsupported("surface pixels");
  }

  removeSurface() {}

  surfaceStats() {
    return JSON.stringify({ submitted: 0, coalesced: 0, presented: 0, rows: 0 });
  }

  startSurfaceCapture(): number {
    unsupported("surface capture");
  }

  stopSurfaceCapture(): string {
    unsupported("surface capture");
  }

  captureIndex(): string {
    unsupported("surface capture");
  }

  captureFrame(): never {
    unsupported("surface capture");
  }

  releaseCapture() {}
}

export const deviceBinding: NativeBinding = {
  PixelEngine: DeviceEngine,
  highlight: (source, language) => call("highlight", source, language),
  highlightCaptures: () => call("highlightCaptures"),
  diff: (oldSource, newSource, contextLines) => call("diff", oldSource, newSource, contextLines ?? null),
  parseMarkdown: (source, streaming) => call("parseMarkdown", source, streaming ?? false),
  encodeRecording: () => Promise.reject(new Error("recording is not available on iOS")),
  captureFilmstrip: () => Promise.reject(new Error("filmstrips are not available on iOS")),
};
