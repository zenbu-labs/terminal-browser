import type { WebContents } from "electron";

const ZOOM_PRESETS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
];

export type ZoomDirection = 1 | -1 | 0;


export function stepZoom(contents: WebContents, direction: ZoomDirection): number {
  const current = contents.getZoomFactor();
  const factor =
    direction === 0
      ? 1
      : direction === 1
        ? (ZOOM_PRESETS.find((preset) => preset > current * 1.001) ?? ZOOM_PRESETS.at(-1)!)
        : ([...ZOOM_PRESETS].reverse().find((preset) => preset < current * 0.999) ??
          ZOOM_PRESETS[0]);
  contents.setZoomFactor(factor);
  return factor;
}


export function scaleZoom(contents: WebContents, ratio: number): number {
  const floor = ZOOM_PRESETS[0];
  const ceiling = ZOOM_PRESETS.at(-1)!;
  const exact = contents.getZoomFactor() * ratio;
  const factor = Math.min(ceiling, Math.max(floor, Math.round(exact * 1000) / 1000));
  contents.setZoomFactor(factor);
  return factor;
}


export function zoomDirection(key: string): ZoomDirection | null {
  if (key === "=" || key === "+") return 1;
  if (key === "-" || key === "_") return -1;
  if (key === "0") return 0;
  return null;
}
