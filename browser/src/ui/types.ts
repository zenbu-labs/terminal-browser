import type { DragEvent, PointerEvent, WheelEvent } from "pixel-react";

export interface PaletteView {
  index: number;
  items: { id: string; label: string; shortcut: string }[];
}

export interface NewTabView {
  suggestions: string[];
  index: number;
}

export interface TabRow {
  id: number;
  title: string;
  favicon: string | null;
  active: boolean;
  loading: boolean;
}

export interface DeviceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DeviceView {
  mode: "phone" | "tablet";
  frame: DeviceRect & { radius: number };
  screen: DeviceRect;
  island: DeviceRect | null;
}

export interface PopupView {
  title: string;
  host: string;
  loading: boolean;
  width: number;
  height: number;
}

export interface DownloadView {
  name: string;
  percent: number | null;
  state: "progressing" | "done" | "failed";
}

export type PageMenuItem =
  | { id: string; label: string; enabled: boolean; shortcut: string }
  | { id: string; separator: true };

export interface PageMenuView {
  x: number;
  y: number;
  items: PageMenuItem[];
}

export interface ChromeActions {
  back(): void;
  forward(): void;
  reload(): void;
  urlEdit(): void;
  urlEditCancel(): void;
  urlSubmit(text: string): void;
  pointer(event: PointerEvent): void;
  wheel(event: WheelEvent): void;
  pageHover(hovering: boolean): void;
  findChange(text: string): void;
  findNext(forward: boolean): void;
  findClose(): void;
  paletteQuery(text: string): void;
  paletteRun(index: number): void;
  paletteClose(): void;
  tabSwitch(id: number): void;
  tabClose(id: number): void;
  tabNew(): void;
  newTabQuery(text: string): void;
  newTabSubmit(text: string): void;
  newTabCancel(): void;
  popupPointer(event: PointerEvent): void;
  popupWheel(event: WheelEvent): void;
  popupClose(): void;
  devtoolsPointer(event: PointerEvent): void;
  devtoolsWheel(event: WheelEvent): void;
  devtoolsHover(hovering: boolean): void;
  devtoolsDividerDrag(event: DragEvent): void;
  devtoolsDividerHover(hovering: boolean): void;
  pageMenuAction(id: string): void;
  pageMenuClose(): void;
  zoomReset(): void;
}

export interface ChromeLayout {
  width: number;
  height: number;
  toolbarHeight: number;
  contentHeight: number;
  page: { x: number; y: number; width: number; height: number };
  devtools: {
    x: number;
    y: number;
    width: number;
    height: number;
    dock: "bottom" | "right";
  } | null;
  rem: number;
}
