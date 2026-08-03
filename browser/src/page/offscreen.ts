import fs from "node:fs";
import { app, BrowserWindow } from "electron";
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
  } else {
    mode = (await probeSharedTexture()) ? "shared-texture" : "bitmap";
  }
  // fd write so the line lands in the log file even after the devtools
  // console capture replaces process.stderr.write
  fs.writeSync(2, `offscreen mode: ${mode}\n`);
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
  try {
    const painted = new Promise<boolean>((resolve) => {
      window.webContents.on("paint", (event) => {
        const texture = event.texture;
        if (!texture) return resolve(false);
        try {
          resolve(textureFrameOf(texture.textureInfo) !== null);
        } finally {
          texture.release();
        }
      });
    });
    const timedOut = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000));
    const loaded = window
      .loadURL("about:blank")
      .then(() => window.webContents.invalidate())
      .then(() => painted);
    return await Promise.race([loaded, timedOut]);
  } catch {
    return false;
  } finally {
    window.destroy();
    await allWindowsClosed;
  }
}
