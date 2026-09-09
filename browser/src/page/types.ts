import type { TextureInfo } from "electron";

export interface BrowserState {
  url: string;
  title: string;
  favicon: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  findMatches: { active: number; total: number } | null;
  zoom: number;
  blocked: number;
}

export function initialBrowserState(url: string): BrowserState {
  return {
    url,
    // yuck
    title: "",
    favicon: null,
    loading: true,
    canGoBack: false,
    canGoForward: false,
    findMatches: null,
    zoom: 1,
    blocked: 0,
  };
}

export interface BrowserSurfaceLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}


export function cssSize(width: number, height: number, scale: number) {
  return {
    width: Math.max(1, Math.floor(width / scale)),
    height: Math.max(1, Math.floor(height / scale)),
  };
}

export function snapToCssGrid(width: number, height: number, scale: number) {
  const css = cssSize(width, height, scale);
  return { width: Math.round(css.width * scale), height: Math.round(css.height * scale) };
}

export function damageOf(info: TextureInfo) {
  const rect = info.metadata?.captureUpdateRect;
  if (!rect || rect.width <= 0 || rect.height <= 0) return undefined;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

export function paintedNothing(info: TextureInfo) {
  const rect = info.metadata?.captureUpdateRect;
  return !!rect && (rect.width <= 0 || rect.height <= 0);
}
