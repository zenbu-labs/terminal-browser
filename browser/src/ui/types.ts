import type { DragEvent, PointerEvent, WheelEvent } from "pixel-react";
import type { RecordActions } from "../record/types";

export interface PaletteView {
  index: number;
  items: { id: string; label: string; shortcut: string }[];
}

export type NewTabSuggestion =
  | { kind: "search"; text: string }
  | { kind: "app"; id: string; name: string };

export interface NewTabView {
  suggestions: NewTabSuggestion[];
  index: number;
}

export interface TabRow {
  id: number;
  title: string;
  favicon: string | null;
  active: boolean;
  app: boolean;
  agentControlled: boolean;
}

export interface PopupView {
  title: string;
  host: string;
  loading: boolean;
  width: number;
  height: number;
}

export interface AdblockView {
  active: boolean;
  blocked: number;
}

export interface DownloadView {
  name: string;
  percent: number | null;
  state: "progressing" | "done" | "failed";
}

export interface PageMenuIcon {
  d: string;
  tint?: "red";
  weight?: number;
}

export type PageMenuItem =
  | { id: string; label: string; enabled: boolean; shortcut: string; icon?: PageMenuIcon }
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
  newTabPick(index: number): void;
  newTabCancel(): void;
  popupPointer(event: PointerEvent): void;
  popupWheel(event: WheelEvent): void;
  popupClose(): void;
  popupHover(hovering: boolean): void;
  devtoolsPointer(event: PointerEvent): void;
  devtoolsWheel(event: WheelEvent): void;
  devtoolsHover(hovering: boolean): void;
  devtoolsDividerDrag(event: DragEvent): void;
  devtoolsDividerHover(hovering: boolean): void;
  adblockToggle(): void;
  pageMenuAction(id: string): void;
  pageMenuClose(): void;
  record: RecordActions;
}

export interface ChromeLayout {
  width: number;
  height: number;
  toolbarHeight: number;
  recordBarHeight: number;
  contentHeight: number;
  page: { x: number; y: number; width: number; height: number };
  devtools: {
    x: number;
    y: number;
    width: number;
    height: number;
    dock: "bottom" | "right";
  } | null;
  frame: boolean;
  rem: number;
}
