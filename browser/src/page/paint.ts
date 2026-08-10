import type { NativeImage, OffscreenSharedTexture, Rectangle, TextureInfo } from "electron";
import type { Surface, SurfaceTexture } from "pixel-react";
import { textureAccepted, textureRejected } from "./offscreen";
import { damageOf, paintedNothing } from "./types";

const DRM_FORMAT_MOD_LINEAR = 0n;
const DRM_FORMAT_MOD_INVALID = 0x00ffffffffffffffn;

function x11Session(): boolean {
  if (process.platform !== "linux") return false;
  if (process.env.XDG_SESSION_TYPE === "x11") return true;
  return !process.env.WAYLAND_DISPLAY && !!process.env.DISPLAY;
}

/** Converts the paint event's platform-specific handle into an engine frame,
 * or a reason the engine cannot map this handle for CPU reads. */
function textureFrameOf(info: TextureInfo): { frame: SurfaceTexture } | { reject: string } {
  const { ioSurface, nativePixmap } = info.handle;
  if (ioSurface) return { frame: { ioSurface } };
  if (!nativePixmap) return { reject: "handle has no ioSurface or nativePixmap" };
  if (nativePixmap.planes.length !== 1) {
    return { reject: `dmabuf has ${nativePixmap.planes.length} planes` };
  }
  let modifier = BigInt(nativePixmap.modifier);
  // X11 reports "invalid" for buffers allocated without modifier awareness,
  // which in practice are linear (obs-browser ships the same equivalence).
  // If one ever isn't, the engine-side import is the safety net.
  if (modifier === DRM_FORMAT_MOD_INVALID && x11Session()) modifier = DRM_FORMAT_MOD_LINEAR;
  // A dmabuf is only CPU-mappable when the GPU laid it out linearly
  // (DRM_FORMAT_MOD_LINEAR, modifier 0); tiled layouts need a GPU blit.
  if (modifier !== DRM_FORMAT_MOD_LINEAR) {
    return { reject: `tiled dmabuf (modifier 0x${modifier.toString(16)})` };
  }
  const [plane] = nativePixmap.planes;
  return {
    frame: {
      pixmap: {
        fd: plane.fd,
        width: info.codedSize.width,
        height: info.codedSize.height,
        stride: plane.stride,
        offset: plane.offset,
        size: plane.size,
        modifier: String(modifier),
      },
    },
  };
}

/** The paint event payload added by the forked Electron's
 * offscreen.useSharedMemory option; the stock typings don't know it. */
export interface OffscreenSoftwareFrame {
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

export function softwareFrameOf(event: unknown): OffscreenSoftwareFrame | undefined {
  const frame = (event as { softwareFrame?: OffscreenSoftwareFrame | null }).softwareFrame;
  return frame ?? undefined;
}

/** Presents one paint event in whichever form it arrived: a shared texture
 * when the session runs zero-copy, a shared memory frame when the patched
 * Electron delivers software frames by fd, otherwise the software bitmap.
 * Returns true when the surface received pixels, so callers know their next
 * paint no longer has to cover the whole surface. */
export function presentPaint(
  surface: Surface,
  texture: OffscreenSharedTexture | undefined,
  softwareFrame: OffscreenSoftwareFrame | undefined,
  image: NativeImage,
  dirtyRect: Rectangle,
  wholeSurface: boolean,
): boolean {
  if (texture) return presentTexture(surface, texture, wholeSurface);
  if (softwareFrame) return presentSoftwareFrame(surface, softwareFrame, dirtyRect, wholeSurface);
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
    if (info.widgetType !== "frame") return false;
    if (info.pixelFormat !== "bgra") {
      textureRejected(`pixel format ${info.pixelFormat}`);
      return false;
    }
    const sized = textureFrameOf(info);
    if ("reject" in sized) {
      textureRejected(sized.reject);
      return false;
    }
    if (paintedNothing(info) && !wholeSurface) return false;
    const damage = wholeSurface ? undefined : damageOf(info);
    if ("pixmap" in sized.frame) {
      try {
        surface.present({ ...sized.frame, damage, released: () => texture.release() });
      } catch (error) {
        textureRejected(`engine import failed: ${String(error)}`);
        return false;
      }
      handedOff = true;
    } else {
      surface.present({ ...sized.frame, damage });
    }
    textureAccepted();
    return true;
  } finally {
    if (!handedOff) texture.release();
  }
}

/** Same release discipline as presentTexture: the pooled region goes back to
 * Electron only after the engine finished reading it. */
function presentSoftwareFrame(
  surface: Surface,
  frame: OffscreenSoftwareFrame,
  dirtyRect: Rectangle,
  wholeSurface: boolean,
): boolean {
  let handedOff = false;
  try {
    const info = frame.frameInfo;
    if (info.widgetType !== "frame") return false;
    if (info.pixelFormat !== "bgra") return false;
    // Offscreen capture is never letterboxed, so rows start at the region's
    // start; a nonzero origin would break that assumption.
    if (info.contentRect.x !== 0 || info.contentRect.y !== 0) return false;
    const update = info.metadata.captureUpdateRect;
    if (update && update.width <= 0 && update.height <= 0 && !wholeSurface) return false;
    const damage =
      wholeSurface || dirtyRect.width <= 0 || dirtyRect.height <= 0 ? undefined : dirtyRect;
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
