import type { WebContents } from "electron";

import type { Tab, TabManager } from "../session/tabs";

export interface ExtensionPrompt {
  kind: "install" | "permissions" | "update" | "remove";
  extensionId: string;
  name: string;
  icon: string | null;
  warnings: string[];
}

export interface PopupWindowRequest {
  windowId: number;
  extensionId: string;
  url: string;
  width: number | null;
  height: number | null;
}

// What an extension needs from one terminal-browser pane. A pane is a Chrome
// "window": it owns a strip of tabs and draws the extension UI.
export interface WindowHost {
  readonly tabs: TabManager;
  focused(): boolean;
  size(): { width: number; height: number };
  resolveUrl(url: string): string;
  closeTab(id: number): void;
  activate(): void;
  extensionsChanged(): void;
  openActionPopup(extensionId: string, url: string): void;
  closeActionPopup(extensionId?: string): void;
  openPopupWindow(request: PopupWindowRequest): Promise<WebContents>;
  closePopupWindow(windowId: number): void;
  // The window's side panels changed; focus means the user just opened one.
  sidePanelsChanged(focus: boolean): void;
  prompt(request: ExtensionPrompt): Promise<boolean>;
  toast(message: string): void;
}

export interface ExtensionWindow {
  readonly id: number;
  readonly host: WindowHost;
}

export type TabRef = { window: ExtensionWindow; tab: Tab };
