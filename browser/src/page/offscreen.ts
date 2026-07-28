import type { OffscreenSharedTexture } from "electron";
import type { Surface } from "pixel-react";

interface PaintEvent {
  texture?: OffscreenSharedTexture;
}

export function offscreenOptions(deviceScaleFactor: number) {
  if (process.platform === "darwin") {
    return {
      useSharedTexture: true,
      sharedTexturePixelFormat: "argb" as const,
      deviceScaleFactor,
    };
  }
  if (process.platform === "linux") {
    return {
      useSharedTexture: false,
      deviceScaleFactor,
    };
  }
  throw new Error(`unsupported platform: ${process.platform}`);
}

export function presentPaint(surface: Surface, event: PaintEvent, visible: boolean): void {
  const texture = event.texture;
  if (!texture) return;
  try {
    if (!visible) return;
    const info = texture.textureInfo;
    const handle = info.handle.ioSurface;
    if (info.widgetType !== "frame" || info.pixelFormat !== "bgra" || !handle) return;
    surface.present({ ioSurface: handle });
  } finally {
    texture.release();
  }
}
