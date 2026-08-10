import type { WebContents } from "electron";

/** Historical Linux workaround, now default-off: stock Electron ignored the
 * offscreen scale option on native Wayland (Chromium's per-surface scaling
 * clobbered it to 1x), so pages rasterized blurry and this module faked
 * density with a device-metrics pin plus page zoom. Our patched Electron
 * fixes the scale option (pixel-electron: osr-wayland-scale.patch), so Linux
 * now takes the same native path as macOS. The zoom machinery stays behind
 * TERMINAL_BROWSER_RENDER_ZOOM=1 as a rollback until the native path has
 * soaked, then this whole file can go. */
export const RENDER_ZOOM =
  process.platform === "linux" && process.env.TERMINAL_BROWSER_RENDER_ZOOM === "1";

export function renderZoomBase(renderScale: number): number {
  return RENDER_ZOOM ? renderScale : 1;
}

export function surfaceSize(
  css: { width: number; height: number },
  renderScale: number,
): { width: number; height: number } {
  if (!RENDER_ZOOM) return css;
  return {
    width: Math.max(1, Math.round(css.width * renderScale)),
    height: Math.max(1, Math.round(css.height * renderScale)),
  };
}

export async function pinSurfacePixels(
  cdp: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  device: { width: number; height: number },
): Promise<void> {
  if (!RENDER_ZOOM) return;
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: device.width,
    height: device.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

/** Chromium keeps zoom per host, so a navigation silently resets it; call this on
 * every main-frame navigation as well as at setup. */
export function applyRenderZoom(
  contents: WebContents,
  renderScale: number,
  userZoom: number,
): void {
  contents.setZoomFactor(renderZoomBase(renderScale) * userZoom);
}
