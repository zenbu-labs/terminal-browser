import type { NativeImage, OffscreenSharedTexture, Rectangle, TextureInfo } from "electron";
import type { Surface, SurfaceTexture } from "pixel-react";
import { damageOf, paintedNothing } from "./types";

/** Converts the paint event's platform-specific handle into an engine frame.
 * Returns null when the handle is one the engine cannot map for CPU reads. */
export function textureFrameOf(info: TextureInfo): SurfaceTexture | null {
  const { ioSurface, nativePixmap } = info.handle;
  if (ioSurface) return { ioSurface };
  if (!nativePixmap || nativePixmap.planes.length !== 1) return null;
  // A dmabuf is only CPU-mappable when the GPU laid it out linearly
  // (DRM_FORMAT_MOD_LINEAR, modifier 0); tiled layouts need a GPU import.
  if (BigInt(nativePixmap.modifier) !== 0n) return null;
  const [plane] = nativePixmap.planes;
  return {
    pixmap: {
      fd: plane.fd,
      width: info.codedSize.width,
      height: info.codedSize.height,
      stride: plane.stride,
      offset: plane.offset,
      size: plane.size,
    },
  };
}

/** Presents one paint event in whichever form it arrived: a shared texture
 * when the session runs zero-copy, otherwise the software bitmap. Returns
 * true when the surface received pixels, so callers know their next paint no
 * longer has to cover the whole surface. */
export function presentPaint(
  surface: Surface,
  texture: OffscreenSharedTexture | undefined,
  image: NativeImage,
  dirtyRect: Rectangle,
  wholeSurface: boolean,
): boolean {
  if (texture) return presentTexture(surface, texture, wholeSurface);
  return presentBitmap(surface, image, wholeSurface ? undefined : dirtyRect);
}

/** Releases the texture -- immediately when it never reaches the engine, and
 * otherwise only after the engine finished reading its memory, so the GPU
 * cannot write the next frame into a buffer that is still being read. */
function presentTexture(
  surface: Surface,
  texture: OffscreenSharedTexture,
  wholeSurface: boolean,
): boolean {
  let handedOff = false;
  try {
    const info = texture.textureInfo;
    if (info.widgetType !== "frame" || info.pixelFormat !== "bgra") return false;
    const frame = textureFrameOf(info);
    if (!frame) return false;
    if (paintedNothing(info) && !wholeSurface) return false;
    const damage = wholeSurface ? undefined : damageOf(info);
    if ("pixmap" in frame) {
      surface.present({ ...frame, damage, released: () => texture.release() });
      handedOff = true;
    } else {
      surface.present({ ...frame, damage });
    }
    return true;
  } finally {
    if (!handedOff) texture.release();
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

/** Presents bitmap paints a task after the paint event, newest frame first.
 * A big pane's bitmap costs several milliseconds of main-thread work per
 * frame; done inside the paint handler it queues in front of input events and
 * the app feels it as scroll latency. The pixels are copied out immediately
 * (Electron reuses the frame's backing buffer) but the engine handoff waits
 * its turn, and a backlog of stale frames collapses into one present. */
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
