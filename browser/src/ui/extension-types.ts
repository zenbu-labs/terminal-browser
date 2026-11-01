import type { WebContents } from "electron";
import type { DragEvent, OpenWindowDecision, WebViewHandle } from "@zenbu-labs/pixel";
import type { ToolbarAction } from "../extensions/action";
import type { ExtensionPrompt } from "../extensions/window";

export type { ToolbarAction };

export interface ExtensionPopupView {
  extensionId: string;
  url: string;
  key: number;
}

export interface ExtensionPopupWindowView {
  windowId: number;
  key: number;
  url: string;
  width: number | null;
  height: number | null;
}

export interface ExtensionSidePanelView {
  key: string;
  extensionId: string;
  name: string;
  url: string;
}

export interface ExtensionsView {
  actions: ToolbarAction[];
  menuOpen: boolean;
  menuIndex: number;
  popup: ExtensionPopupView | null;
  popupWindows: ExtensionPopupWindowView[];
  sidePanel: ExtensionSidePanelView | null;
  // Every live panel page; only `sidePanel` is visible, the rest keep their state hidden.
  sidePanels: ExtensionSidePanelView[];
  prompt: Omit<ExtensionPrompt, "extensionId"> | null;
  scale: number;
  onToolbar: boolean;
}

export interface ExtensionActions {
  click(extensionId: string): void;
  contextMenu(extensionId: string, x: number, y: number): void;
  setPinned(extensionId: string, pinned: boolean): void;
  toggleMenu(): void;
  menuHover(index: number): void;
  openManager(): void;
  popupMounted(contents: WebContents): void;
  popupClose(): void;
  popupWindowMounted(windowId: number, contents: WebContents): void;
  popupWindowClose(windowId: number): void;
  popupWindowFocus(windowId: number): void;
  sidePanelMounted(key: string, view: WebViewHandle): void;
  sidePanelClose(): void;
  sidePanelDividerDrag(event: DragEvent): void;
  answerPrompt(accepted: boolean): void;
  openWindow(details: Electron.HandlerDetails): OpenWindowDecision;
}
