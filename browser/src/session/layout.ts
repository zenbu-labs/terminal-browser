import type { EngineInfo } from "pixel-react";
import type { DevtoolsDock } from "pixel-store";
import { snapToCssGrid, type BrowserSurfaceLayout, type DeviceSpec } from "../page/types";
import type { ChromeLayout, DeviceView } from "../ui/types";

export type DeviceMode = "desktop" | "phone" | "tablet";

export const DEVICES: Record<Exclude<DeviceMode, "desktop">, DeviceSpec> = {
  phone: {
    width: 393,
    height: 852,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  },
  tablet: {
    width: 820,
    height: 1180,
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  },
};

export function deviceSpec(mode: DeviceMode): DeviceSpec | null {
  return mode === "desktop" ? null : DEVICES[mode];
}

export interface SessionLayout {
  chrome: ChromeLayout;
  surface: BrowserSurfaceLayout;
  devtools: BrowserSurfaceLayout | null;
  device: DeviceView | null;
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

export function computeLayout(
  info: EngineInfo,
  scale: number,
  mode: DeviceMode,
  hideToolbar: boolean,
  devtools: DevtoolsPlacement | null,
): SessionLayout {
  const toolbarHeight = hideToolbar
    ? 0
    : Math.min(info.height - info.cellHeight, Math.round(info.basePx * 2.1));
  const pad = Math.round(info.basePx * 0.45);
  const padLeft = Math.round(info.basePx * 0.2);
  const padBottom = Math.round(info.basePx * 0.2);
  const chrome: ChromeLayout = {
    width: info.width,
    height: info.height,
    toolbarHeight,
    contentHeight: Math.max(1, info.height - toolbarHeight),
    page: {
      x: padLeft,
      y: toolbarHeight,
      width: Math.max(1, info.width - padLeft - pad),
      height: Math.max(1, info.height - toolbarHeight - padBottom),
    },
    devtools: null,
    rem: info.basePx,
  };
  if (mode === "desktop") {
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
      device: null,
    };
  }
  const spec = DEVICES[mode];
  const margin = info.basePx * 1.1;
  const availW = Math.max(40, info.width - margin * 2);
  const availH = Math.max(40, chrome.contentHeight - margin * 2);
  const bezel = mode === "phone" ? 0.035 : 0.05;
  const aspect = spec.width / spec.height;
  const screenW = Math.min(availW / (1 + 2 * bezel), availH / (1 / aspect + 2 * bezel));
  const screenH = screenW / aspect;
  const bezelPx = screenW * bezel;
  const frameW = screenW + 2 * bezelPx;
  const frameH = screenH + 2 * bezelPx;
  const frameX = (info.width - frameW) / 2;
  const frameY = toolbarHeight + (chrome.contentHeight - frameH) / 2;
  const screen = { x: frameX + bezelPx, y: frameY + bezelPx, w: screenW, h: screenH };
  const s = screenW / spec.width;
  return {
    chrome,
    surface: {
      x: screen.x,
      y: screen.y,
      ...snapToCssGrid(screenW, screenH, s),
      scale: s,
    },
    devtools: null,
    device: {
      mode,
      frame: {
        x: frameX,
        y: frameY,
        w: frameW,
        h: frameH,
        radius: mode === "phone" ? screenW * 0.16 : screenW * 0.06,
      },
      screen,
      island:
        mode === "phone"
          ? {
              x: screen.x + (screenW - 125 * s) / 2,
              y: screen.y + 11 * s,
              w: 125 * s,
              h: 37 * s,
            }
          : null,
    },
  };
}
