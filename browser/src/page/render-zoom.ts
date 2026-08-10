import type { WebContents } from "electron";

/** On Linux the offscreen scale option changes nothing: frames come back sized in
 * CSS pixels no matter what scale the window asked for, so pages rasterize at 1x
 * and blur when the engine stretches them onto a denser pane. The way out is to
 * stop asking for a scale at all: pin the frame to the pane's device pixels with a
 * device-metrics override (which also frees the frame from the window manager's
 * screen-size clamp on tall panes) and let page zoom lay content back out at CSS
 * size. Pages see the right devicePixelRatio and paint pixel-for-pixel. On macOS
 * the offscreen scale works, so all of this stays inert. */
export const RENDER_ZOOM = process.platform === "linux";

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
