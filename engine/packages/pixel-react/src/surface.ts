import type { NativeEngine } from "./native";

/** One frame of surface content: either a CPU pixel buffer, or the IOSurface
 * handle Electron exposes on shared-texture paint events (macOS only). */
export type SurfaceFrame =
  | { bgra: Buffer; width: number; height: number }
  | { ioSurface: Buffer };

/** Streams client-rendered pixels into the engine. Create with
 * `root.createSurface()`, pass to a Box's `surface` prop to paint the latest
 * frame scaled into that node's rect, and `close()` when done — unmounting
 * the Box releases the placement but not the pixel buffer. */
export class Surface {
  private readonly id: number;
  private readonly engine: NativeEngine;
  private closed = false;

  constructor(engine: NativeEngine, id: number) {
    this.engine = engine;
    this.id = id;
  }

  present(frame: SurfaceFrame): void {
    if (this.closed) throw new Error("surface is closed");
    if ("ioSurface" in frame) {
      const submit = this.engine.updateSurfaceTexture;
      if (!submit) throw new Error("IOSurface frames are not supported on this platform");
      submit.call(this.engine, this.id, frame.ioSurface);
    } else {
      this.engine.updateSurface(this.id, frame.bgra, frame.width, frame.height);
    }
  }

  /** Drops the current frame; nodes referencing this surface paint nothing
   * until the next present. Use when the content resizes and a stale frame
   * would show scaled. */
  clear(): void {
    if (this.closed) return;
    this.engine.removeSurface(this.id);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.engine.removeSurface(this.id);
  }
}

export function surfaceId(surface: Surface): number {
  return (surface as unknown as { id: number }).id;
}
