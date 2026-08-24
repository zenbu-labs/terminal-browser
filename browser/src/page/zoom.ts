import type { WebContents } from "electron";

const ZOOM_PRESETS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
];

export type ZoomDirection = 1 | -1 | 0;


/**
 * The zoom factor Chromium holds is the user's zoom multiplied by the display
 * correction (see DisplayScale), so callers track the user's own zoom and
 * write the product. These helpers only move the user's number.
 */
export function stepUserZoom(current: number, direction: ZoomDirection): number {
  if (direction === 0) return 1;
  if (direction === 1) {
    return ZOOM_PRESETS.find((preset) => preset > current * 1.001) ?? ZOOM_PRESETS.at(-1)!;
  }
  return [...ZOOM_PRESETS].reverse().find((preset) => preset < current * 0.999) ?? ZOOM_PRESETS[0];
}


export function clampUserZoom(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(ZOOM_PRESETS.at(-1)!, Math.max(ZOOM_PRESETS[0], Math.round(value * 1000) / 1000));
}


export function zoomDirection(key: string): ZoomDirection | null {
  if (key === "=" || key === "+") return 1;
  if (key === "-" || key === "_") return -1;
  if (key === "0") return 0;
  return null;
}
