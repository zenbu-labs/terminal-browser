import { appLog } from "../react";


const SHM_FRAMES = process.platform === "linux" && process.env.PIXEL_SHM !== "0";

export function offscreenPreferences(
  deviceScaleFactor: number,
): Electron.WebPreferences["offscreen"] {
  if (process.platform === "darwin") {
    return { useSharedTexture: true, sharedTexturePixelFormat: "argb", deviceScaleFactor };
  }
  return {
    useSharedTexture: false,
    useSharedMemory: SHM_FRAMES,
    deviceScaleFactor,
  }
}

export function initOffscreenMode(sharedTextures: boolean): void {
  if (process.platform === "darwin" && !sharedTextures) {
    throw new Error("wrong electron build installed");
  }
  const mode = process.platform === "darwin" ? "shared-texture" : SHM_FRAMES ? "shm" : "bitmap";
  appLog("info", "texture", `offscreen mode: ${mode}`);
}
