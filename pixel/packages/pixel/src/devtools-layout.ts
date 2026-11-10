import type { DevtoolsDock } from "./web/types";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DevtoolsPlacement {
  dock: DevtoolsDock;
  fraction: number;
}

export function clampDevtoolsFraction(value: number): number {
  return Math.max(0.15, Math.min(0.85, value));
}

export function dividerFraction(
  page: Rect,
  devtools: Rect & { dock: DevtoolsDock },
  x: number,
  y: number,
): number {
  const fraction =
    devtools.dock === "bottom"
      ? (devtools.y + devtools.height - y) / (devtools.y + devtools.height - page.y)
      : (devtools.x + devtools.width - x) / (devtools.x + devtools.width - page.x);
  return clampDevtoolsFraction(fraction);
}

export function splitForDevtools(
  page: Rect,
  placement: DevtoolsPlacement | null,
  gap: number,
): { page: Rect; devtools: (Rect & { dock: DevtoolsDock }) | null } {
  if (!placement) return { page, devtools: null };
  const fraction = clampDevtoolsFraction(placement.fraction);
  if (placement.dock === "bottom") {
    const devtoolsHeight = Math.round(page.height * fraction);
    const pageHeight = Math.max(1, page.height - devtoolsHeight - gap);
    return {
      page: { ...page, height: pageHeight },
      devtools: {
        x: page.x,
        y: page.y + pageHeight + gap,
        width: page.width,
        height: Math.max(1, devtoolsHeight),
        dock: "bottom",
      },
    };
  }
  const devtoolsWidth = Math.round(page.width * fraction);
  const pageWidth = Math.max(1, page.width - devtoolsWidth - gap);
  return {
    page: { ...page, width: pageWidth },
    devtools: {
      x: page.x + pageWidth + gap,
      y: page.y,
      width: Math.max(1, devtoolsWidth),
      height: page.height,
      dock: "right",
    },
  };
}
