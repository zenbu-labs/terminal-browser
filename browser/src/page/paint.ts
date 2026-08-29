import type { NativeImage, OffscreenSharedTexture, Rectangle } from "electron";
import type { Surface } from "pixel-react";
import { damageOf, paintedNothing } from "./types";



// we need to add this type, its based on an electron patch this project owns
export interface ShmFrame {
  release(): void;
  frameInfo: {
    pixelFormat: string;
    widgetType: string;
    codedSize: { width: number; height: number };
    contentRect: Rectangle;
    stride: number;
    dataSize: number;
    timestamp: number;
    metadata: {
      captureUpdateRect?: Rectangle;
      sourceSize?: { width: number; height: number };
      frameCount: number;
    };
    fd: number;
  };
}

export function shmFrameOf(event: unknown): ShmFrame | undefined {
  const frame = (event as { softwareFrame?: ShmFrame | null }).softwareFrame;
  return frame ?? undefined;
}


export function presentPaint(
  surface: Surface,
  texture: OffscreenSharedTexture | undefined,
  shmFrame: ShmFrame | undefined,
  image: NativeImage,
  dirtyRect: Rectangle,
  wholeSurface: boolean,
): boolean {
  if (texture) return presentTexture(surface, texture, wholeSurface);
  if (shmFrame) return presentShmFrame(surface, shmFrame, dirtyRect, wholeSurface);
  return presentBitmap(surface, image, wholeSurface ? undefined : dirtyRect);
}


function presentTexture(
  surface: Surface,
  texture: OffscreenSharedTexture,
  wholeSurface: boolean,
): boolean {
  try {
    const info = texture.textureInfo;
    if (info.widgetType !== "frame" || info.pixelFormat !== "bgra") return false;
    const { ioSurface } = info.handle;
    if (!ioSurface) return false;
    if (paintedNothing(info) && !wholeSurface) return false;
    surface.present({ ioSurface, damage: wholeSurface ? undefined : damageOf(info) });
    return true;
  } finally {
    texture.release();
  }
}


function presentShmFrame(
  surface: Surface,
  frame: ShmFrame,
  dirtyRect: Rectangle,
  wholeSurface: boolean,
): boolean {
  let handedOff = false;
  try {
    const info = frame.frameInfo;
    if (info.widgetType !== "frame") return false;
    if (info.pixelFormat !== "bgra") return false;
    if (info.contentRect.x !== 0 || info.contentRect.y !== 0) return false;
    const update = info.metadata.captureUpdateRect;
    const damage =
      wholeSurface
        ? undefined
        : update && update.width > 0 && update.height > 0
          ? update
          : dirtyRect.width > 0 && dirtyRect.height > 0
            ? dirtyRect
            : undefined;
    try {
      surface.present({
        shm: {
          fd: info.fd,
          width: info.contentRect.width,
          height: info.contentRect.height,
          stride: info.stride,
          size: info.dataSize,
        },
        damage,
        released: () => frame.release(),
      });
    } catch {
      return false;
    }
    handedOff = true;
    return true;
  } finally {
    if (!handedOff) frame.release();
  }
}

function presentBitmap(surface: Surface, image: NativeImage, dirtyRect?: Rectangle): boolean {
  const size = image.getSize();
  if (size.width <= 0 || size.height <= 0) return false;
  const damage = dirtyRect && dirtyRect.width > 0 && dirtyRect.height > 0 ? dirtyRect : undefined;
  surface.present({ bgra: image.toBitmap(), width: size.width, height: size.height, damage });
  return true;
}

function unionRect(a: Rectangle, b: Rectangle): Rectangle {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

interface PendingBitmap {
  bgra: Buffer;
  width: number;
  height: number;
  damage?: Rectangle;
  whole: boolean;
}


export class BitmapPresenter {
  private readonly surface: Surface;
  private pending: PendingBitmap | null = null;
  private scheduled = false;

  constructor(surface: Surface) {
    this.surface = surface;
  }

  push(image: NativeImage, dirtyRect: Rectangle, wholeSurface: boolean): boolean {
    const size = image.getSize();
    if (size.width <= 0 || size.height <= 0) return false;
    const fresh = dirtyRect.width > 0 && dirtyRect.height > 0 ? dirtyRect : undefined;
    const stale = this.pending;
    const carried =
      stale && stale.width === size.width && stale.height === size.height ? stale : null;
    const damage = carried?.damage && fresh ? unionRect(carried.damage, fresh) : fresh;
    this.pending = {
      bgra: image.toBitmap(),
      width: size.width,
      height: size.height,
      damage,
      whole: wholeSurface || (carried?.whole ?? false) || (stale != null && !carried),
    };
    if (!this.scheduled) {
      this.scheduled = true;
      setImmediate(() => this.drain());
    }
    return true;
  }

  private drain(): void {
    this.scheduled = false;
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    this.surface.present({
      bgra: pending.bgra,
      width: pending.width,
      height: pending.height,
      damage: pending.whole ? undefined : pending.damage,
    });
  }
}
