import type { CompletionItem } from "./completion/complete";
import type { AiChoice } from "./ai/models";
import type { ModelGroup } from "./view/modelmenu";
import type { BarColors } from "./view/sizes";

export const MENU_KEYS = ["up", "down", "left", "right", "enter", "escape"];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BarView {
  inset: { left: number; top?: number; bottom?: number };
  width: number;
  maxHeight: number;
  busy: boolean;
  ready: boolean;
  status: string | null;
  answer: string;
  error: string | null;
  notice: string | null;
  model: { groups: ModelGroup[]; choice: AiChoice; label: string; conversation: boolean; open: boolean } | null;
}

export interface CompletionView {
  left: number;
  top: number;
  rows: CompletionItem[];
  selected: number;
  top_: number;
  visible: number;
  width: number;
  empty: string | null;
  more: number;
  details: { inset: { left: number; top?: number; bottom?: number }; width: number; item: CompletionItem } | null;
}

export interface MenuView {
  x: number;
  y: number;
  items: ({ label: string; shortcut?: string; enabled?: boolean } | "separator")[];
}

export interface ViewState {
  colors: BarColors;
  menuColors: BarColors;
  bar: BarView | null;
  completion: CompletionView | null;
  menu: MenuView | null;
}

export type ToView =
  | { type: "state"; state: ViewState }
  | { type: "input"; text: string }
  | { type: "focusInput" }
  | { type: "page"; direction: 1 | -1 }
  | { type: "menuKey"; key: string };

export type FromView =
  | { type: "hello"; basePx: number }
  | { type: "regions"; regions: Record<string, Rect | null> }
  | { type: "text"; value: string }
  | { type: "submit" }
  | { type: "stop" }
  | { type: "close" }
  | { type: "focusBar" }
  | { type: "pick"; row: number }
  | { type: "wheel"; rows: number }
  | { type: "menu"; index: number }
  | { type: "picker"; open: boolean }
  | { type: "choice"; choice: AiChoice };
