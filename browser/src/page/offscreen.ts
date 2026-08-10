import fs from "node:fs";
import { appLog } from "pixel-react";

/** How offscreen windows deliver frames to the engine. "shared-texture" is
 * zero-copy (IOSurface on macOS, linear dmabuf on Linux); "bitmap" is the
 * slower software path where Electron hands each paint over as pixels. */
type OffscreenMode = "shared-texture" | "bitmap";

let mode: OffscreenMode = "shared-texture";
let pinned = false;
let demoted: (() => void) | null = null;
let rejectionStreak = 0;
const loggedReasons = new Set<string>();

/** One unreadable texture could be a fluke; a run of them means every frame
 * from this GPU will fail the same way and the session is on the wrong mode. */
const DEMOTION_THRESHOLD = 3;

/** Zero-copy software frames need the rebuilt Electron, so they stay opt-in
 * until that binary has soaked; without the flag bitmap windows keep using
 * the copying NativeImage path. */
const SHM_FRAMES = process.platform === "linux" && process.env.TERMINAL_BROWSER_SHM === "1";

export function offscreenPreferences(
  deviceScaleFactor: number,
): Electron.WebPreferences["offscreen"] {
  if (mode === "shared-texture") {
    return { useSharedTexture: true, sharedTexturePixelFormat: "argb", deviceScaleFactor };
  }
  return {
    useSharedTexture: false,
    useSharedMemory: SHM_FRAMES,
    deviceScaleFactor,
  } as Electron.WebPreferences["offscreen"];
}

export function offscreenMode(): OffscreenMode {
  return mode;
}

/** Decides the starting mode. There is no startup probe: every window opens
 * wanting shared textures, and the first real window's paints are the test.
 * Texture-less paints flow through the bitmap presenter (that is Electron's
 * software-compositing path working as designed), and textures the engine
 * cannot read demote the whole session (see textureRejected). */
export function initOffscreenMode(sharedTextures: boolean): void {
  if (process.platform === "darwin") {
    if (!sharedTextures) {
      throw new Error("terminal-browser requires the patched Electron with shared texture support");
    }
    // IOSurfaces are always CPU-mappable, so demotion can never be right.
    pinned = true;
  } else if (!sharedTextures || process.env.TERMINAL_BROWSER_SHARED_TEXTURE === "0") {
    mode = "bitmap";
    pinned = true;
  } else if (process.env.TERMINAL_BROWSER_SHARED_TEXTURE === "1") {
    pinned = true;
  }
  // fd write so the line lands in the log file even after the devtools
  // console capture replaces process.stderr.write
  fs.writeSync(2, `offscreen mode: ${mode}\n`);
  appLog("info", "texture", `offscreen mode: ${mode}`);
}

/** Runs when the session flips to bitmap mode. The mode of an existing window
 * cannot change (it is fixed at creation), so the handler must rebuild the
 * windows; registering it is the session's job. */
export function onDemoted(handler: () => void): void {
  demoted = handler;
}

/** Reports a texture paint the engine could not consume. Texture paints carry
 * no bitmap to fall back on, so each rejected one is a lost frame; a streak of
 * them flips the session to bitmap mode. */
export function textureRejected(reason: string): void {
  if (!loggedReasons.has(reason)) {
    loggedReasons.add(reason);
    fs.writeSync(2, `shared texture rejected: ${reason}\n`);
    appLog("warn", "texture", `rejected: ${reason}`);
  }
  rejectionStreak += 1;
  if (rejectionStreak >= DEMOTION_THRESHOLD) demoteToBitmap(reason);
}

export function textureAccepted(): void {
  rejectionStreak = 0;
}

export function demoteToBitmap(cause: string): void {
  if (mode === "bitmap") return;
  if (pinned) {
    fs.writeSync(2, `offscreen mode pinned, not demoting (${cause})\n`);
    return;
  }
  mode = "bitmap";
  fs.writeSync(2, `offscreen mode: bitmap (demoted: ${cause})\n`);
  appLog("warn", "texture", `demoted to bitmap: ${cause}`);
  // Rejections are reported from inside paint events, and rebuilding windows
  // while one is dispatching its own paint stalls Electron's offscreen
  // pipeline, so the rebuild runs on its own turn.
  const handler = demoted;
  if (handler) setImmediate(handler);
}
