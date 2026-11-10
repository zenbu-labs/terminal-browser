import type { DevtoolsDock, EngineInfo } from "@zenbu-labs/pixel";

export interface SurfaceLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

function snapToCssGrid(width: number, height: number, scale: number) {
  const css = {
    width: Math.max(1, Math.floor(width / scale)),
    height: Math.max(1, Math.floor(height / scale)),
  };
  return { width: Math.round(css.width * scale), height: Math.round(css.height * scale) };
}
import type { ChromeLayout } from "../ui/types";

export interface SessionLayout {
  chrome: ChromeLayout;
  surface: SurfaceLayout;
  devtools: SurfaceLayout | null;
}

export interface DevtoolsPlacement {
  dock: DevtoolsDock;
  fraction: number;
}

export function clampDevtoolsFraction(value: number): number {
  return Math.max(0.15, Math.min(0.85, value));
}

export function dividerFraction(
  page: { x: number; y: number; width: number; height: number },
  devtools: { x: number; y: number; width: number; height: number; dock: DevtoolsDock },
  x: number,
  y: number,
): number {
  const fraction =
    devtools.dock === "bottom"
      ? (devtools.y + devtools.height - y) / (devtools.y + devtools.height - page.y)
      : (devtools.x + devtools.width - x) / (devtools.x + devtools.width - page.x);
  return clampDevtoolsFraction(fraction);
}

type PageRect = ChromeLayout["page"];

function splitForDevtools(
  page: PageRect,
  placement: DevtoolsPlacement | null,
  gap: number,
): { page: PageRect; devtools: (PageRect & { dock: DevtoolsDock }) | null } {
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

export function recordBarHeight(info: EngineInfo): number {
  return Math.round(info.basePx * 4.0);
}

export function computeLayout(
  info: EngineInfo,
  scale: number,
  devtools: DevtoolsPlacement | null,
  recordBar = 0,
  bare = false,
): SessionLayout {
  const toolbarHeight = bare
    ? 0
    : Math.min(info.height - info.cellHeight, Math.round(info.basePx * 2.1));
  const pad = bare ? 0 : Math.round(info.basePx * 0.45);
  const padLeft = bare ? 0 : Math.round(info.basePx * 0.2);
  const padBottom = bare ? 0 : Math.round(info.basePx * 0.2);
  const chrome: ChromeLayout = {
    width: info.width,
    height: info.height,
    toolbarHeight,
    recordBarHeight: recordBar,
    contentHeight: Math.max(1, info.height - toolbarHeight - recordBar),
    page: {
      x: padLeft,
      y: toolbarHeight,
      width: Math.max(1, info.width - padLeft - pad),
      height: Math.max(1, info.height - toolbarHeight - padBottom - recordBar),
    },
    devtools: null,
    rem: info.basePx,
    frame: bare ? 0 : Math.max(1, Math.round(scale)),
    radius: bare ? 0 : Math.max(2, info.basePx * 0.55 - 1),
  };
  const gap = Math.max(2, Math.round(info.basePx * 0.25));
  const split = splitForDevtools(chrome.page, devtools, gap);
  chrome.page = { ...split.page, ...snapToCssGrid(split.page.width, split.page.height, scale) };
  chrome.devtools = split.devtools && {
    ...split.devtools,
    ...snapToCssGrid(split.devtools.width, split.devtools.height, scale),
  };
  return {
    chrome,
    surface: { ...chrome.page, scale },
    devtools: chrome.devtools ? { ...chrome.devtools, scale } : null,
  };
}
