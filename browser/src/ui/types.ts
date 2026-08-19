import type { DragEvent, PointerEvent, WheelEvent } from "pixel-react";
import type { RecordActions } from "../record/types";

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

export interface ImportHintView {
  open: boolean;
  /** Already formatted by the session, e.g. "Detected: Google Chrome, Brave, +2 more." */
  summary: string;
}

export interface ProfileMenuView {
  open: boolean;
  activeSlug: string;
  activeName: string;
  items: { slug: string; name: string; active: boolean }[];
  /** The row whose right-click menu is open, if any. */
  contextSlug: string | null;
  /** Set while a name is being typed; null when no prompt is up. */
  prompt: { kind: "create" | "rename"; text: string } | null;
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
  popupHover(hovering: boolean): void;
  devtoolsPointer(event: PointerEvent): void;
  devtoolsWheel(event: WheelEvent): void;
  devtoolsHover(hovering: boolean): void;
  devtoolsDividerDrag(event: DragEvent): void;
  devtoolsDividerHover(hovering: boolean): void;
  pageMenuAction(id: string): void;
  pageMenuClose(): void;
  focusModeToggle(): void;
  screenshotPage(): void;
  devtoolsToggle(): void;
  importHintToggle(): void;
  importRun(): void;
  profileMenuToggle(): void;
  profileSwitch(slug: string): void;
  /** No name opens the prompt; a name commits it. */
  profileCreate(name?: string): void;
  profileRename(name?: string): void;
  /** Opens a row's right-click menu, or closes whichever is open. */
  profileContext(slug: string | null): void;
  profileDelete(slug: string): void;
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
