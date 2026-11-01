import type { WebContents } from "electron";

export interface ZoomSettings {
  mode: "automatic" | "manual" | "disabled";
  scope: "per-origin" | "per-tab";
}

type NativeZoomMode = ReturnType<WebContents["getZoomMode"]>;

const SETTINGS: Record<NativeZoomMode, ZoomSettings> = {
  default: { mode: "automatic", scope: "per-origin" },
  isolated: { mode: "automatic", scope: "per-tab" },
  manual: { mode: "manual", scope: "per-tab" },
  disabled: { mode: "disabled", scope: "per-tab" },
};

export function zoomSettings(contents: WebContents): ZoomSettings {
  return SETTINGS[contents.getZoomMode()];
}

export function nativeZoomMode({ mode, scope }: ZoomSettings): NativeZoomMode {
  if (mode === "automatic") return scope === "per-tab" ? "isolated" : "default";
  return mode;
}

export interface ZoomChange {
  oldZoomFactor: number;
  newZoomFactor: number;
}

// Fired by pixel's Electron patches whenever the page's effective zoom changes, whatever changed it.
export function onZoomLevelChanged(contents: WebContents, listener: (change: ZoomChange) => void) {
  (contents as unknown as NodeJS.EventEmitter).on("zoom-level-changed", (_event: unknown, change: ZoomChange) => listener(change));
}
