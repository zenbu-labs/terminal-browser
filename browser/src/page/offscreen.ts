import fs from "node:fs";
import { app, BrowserWindow } from "electron";
import { appLog } from "pixel-react";
import { textureFrameOf } from "./paint";

/** How offscreen windows deliver frames to the engine. "shared-texture" is
 * zero-copy (IOSurface on macOS, linear dmabuf on Linux); "bitmap" is the
 * slower software path where Electron hands each paint over as pixels. */
type OffscreenMode = "shared-texture" | "bitmap";

let mode: OffscreenMode = "shared-texture";

function sharedTexturePreferences(deviceScaleFactor: number): Electron.WebPreferences["offscreen"] {
  return { useSharedTexture: true, sharedTexturePixelFormat: "argb", deviceScaleFactor };
}

export function offscreenPreferences(
  deviceScaleFactor: number,
): Electron.WebPreferences["offscreen"] {
  return mode === "shared-texture"
    ? sharedTexturePreferences(deviceScaleFactor)
    : { useSharedTexture: false, deviceScaleFactor };
}

/** Decides the offscreen mode for this session, before any page window
 * exists. macOS always has mappable IOSurfaces; on Linux one probe paint
 * tells us whether the GPU hands over textures the engine can map. */
export async function resolveOffscreenMode(sharedTextures: boolean): Promise<void> {
  if (process.platform === "darwin") {
    if (!sharedTextures) {
      throw new Error("terminal-browser requires the patched Electron with shared texture support");
    }
    mode = "shared-texture";
  } else if (!sharedTextures || process.env.TERMINAL_BROWSER_SHARED_TEXTURE === "0") {
    mode = "bitmap";
  } else if (process.env.TERMINAL_BROWSER_SHARED_TEXTURE === "1") {
    // Forced on: skip the probe (useful when the probe misjudges a machine).
    mode = "shared-texture";
  } else {
    // Default: one probe paint decides. Mappability is the only question --
    // the engine reads dmabufs through the GPU driver's own mapping (gbm),
    // which picks per buffer between a direct pointer and a staged copy, so
    // there is no slow-placement machine to guard against.
    mode = (await probeSharedTexture()) ? "shared-texture" : "bitmap";
  }
  // fd write so the line lands in the log file even after the devtools
  // console capture replaces process.stderr.write
  fs.writeSync(2, `offscreen mode: ${mode}\n`);
  appLog("info", "scale", `offscreen mode: ${mode}`);
}

async function probeSharedTexture(): Promise<boolean> {
  const allWindowsClosed = new Promise<void>((resolve) => {
    app.once("window-all-closed", resolve);
  });
  const window = new BrowserWindow({
    width: 32,
    height: 32,
    show: false,
    frame: false,
    webPreferences: {
      offscreen: sharedTexturePreferences(1),
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  let kick: NodeJS.Timeout | undefined;
  try {
    // GPU startup delivers a few software frames before the texture pipeline
    // comes up, so an early paint proves nothing: only a mappable texture
    // decides, and anything else keeps repainting until the deadline.
    const painted = new Promise<boolean>((resolve) => {
      window.webContents.on("paint", (event) => {
        const texture = event.texture;
        if (!texture) return;
        try {
          if (textureFrameOf(texture.textureInfo) !== null) resolve(true);
        } finally {
          texture.release();
        }
      });
    });
    const timedOut = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000));
    await window.loadURL("about:blank");
    window.webContents.invalidate();
    kick = setInterval(() => window.webContents.invalidate(), 250);
    return await Promise.race([painted, timedOut]);
  } catch {
    return false;
  } finally {
    if (kick) clearInterval(kick);
    window.destroy();
    await allWindowsClosed;
  }
}
