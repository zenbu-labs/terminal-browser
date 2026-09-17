import type { RefObject } from "react";
import type {
  DownloadProgress,
  DragEvent,
  OpenWindowDecision,
  PointerEvent,
  WebViewHandle,
  WebViewState,
} from "@zenbu-labs/pixel";
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
  agentControlled: boolean;
}

export interface DownloadView {
  name: string;
  percent: number | null;
  state: "progressing" | "done" | "failed";
}

export type PageMenuIcon =
  | { kind: "path"; d: string; tint?: "red"; weight?: number }
  | { kind: "image"; src: string };

export interface PageMenuItem {
  id: string;
  label: string;
  enabled: boolean;
  shortcut: string;
  icon?: PageMenuIcon;
  kind?: "item" | "zoom";
  zoomPercent?: string;
}


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
  findChange(text: string): void;
  findNext(forward: boolean): void;
  findClose(): void;
  paletteQuery(text: string): void;
  paletteRun(index: number): void;
  paletteClose(): void;
  tabSwitch(id: number): void;
  tabClose(id: number): void;
  tabNew(): void;
  tabMenu(): void;
  newTabQuery(text: string): void;
  newTabSubmit(text: string): void;
  newTabPick(index: number): void;
  newTabCancel(): void;
  devtoolsDividerDrag(event: DragEvent): void;
  devtoolsAction(action: "close" | "dock-bottom" | "dock-right"): void;
  devtoolsDividerHover(hovering: boolean): void;
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
  rem: number;
}

export interface TabView {
  id: number;
  url: string;
  ref: RefObject<WebViewHandle>;
  active: boolean;
  hidden: boolean;
  partition: string | null;
  proxy: string | null;
  preload: string | null;
  clipboardRead: boolean;
}

export interface TabActions {
  state(id: number, state: WebViewState): void;
  openWindow(id: number, details: Electron.HandlerDetails): OpenWindowDecision;
  contextMenu(id: number, params: Electron.ContextMenuParams): void;
  download(progress: DownloadProgress): void;
  pointer(id: number, event: PointerEvent): void;
}

export interface DevtoolsView {
  dock: "bottom" | "right";
  panel: string | null;
}
