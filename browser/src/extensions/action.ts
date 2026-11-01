import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { app, nativeImage } from "electron";

import { updateExtension } from "shared";

import type { Tab } from "../session/tabs";
import type { LoadedExtension } from "./loaded";
import { manifestAction, pickIcon, resolveExtensionPath } from "./manifest";
import type { Caller } from "./router";
import type { ExtensionService } from "./service";
import type { ExtensionWindow } from "./window";

type Rgba = [number, number, number, number];

interface ActionFields {
  title: string;
  icon: string | null;
  popup: string;
  badgeText: string;
  badgeBackground: Rgba | null;
  badgeColor: Rgba | null;
  enabled: boolean;
}

interface ActionState {
  defaults: ActionFields;
  tabs: Map<number, Partial<ActionFields>>;
}

export interface ToolbarAction {
  extensionId: string;
  name: string;
  title: string;
  icon: string | null;
  badge: { text: string; background: Rgba; color: Rgba } | null;
  enabled: boolean;
  pinned: boolean;
  hasPopup: boolean;
}

const DEFAULT_BADGE: Rgba = [96, 99, 106, 255];
const TOOLBAR_ICON_PX = 32;

function iconCacheDir(): string {
  const dir = path.join(app.getPath("userData"), "extension-icons");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function parseColor(value: unknown): Rgba | null {
  if (Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === "number")) {
    return value.map((n) => Math.max(0, Math.min(255, Math.round(n)))) as Rgba;
  }
  if (typeof value !== "string") return null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((d) => d + d).join("") : hex[1];
    return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)).concat(255) as Rgba;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(value.trim());
  if (rgb) {
    const parts = rgb[1].split(",").map((part) => parseFloat(part));
    if (parts.length >= 3) return [parts[0], parts[1], parts[2], Math.round((parts[3] ?? 1) * 255)] as Rgba;
  }
  return null;
}

function writeImageData(extensionId: string, image: { width: number; height: number; data: Uint8Array }): string {
  const { width, height, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > 512 || height > 512) {
    throw new Error("Icon invalid.");
  }
  if (data.length !== width * height * 4) throw new Error("Icon invalid.");
  const bgra = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 4) {
    bgra[i] = data[i + 2];
    bgra[i + 1] = data[i + 1];
    bgra[i + 2] = data[i];
    bgra[i + 3] = data[i + 3];
  }
  const png = nativeImage.createFromBitmap(bgra, { width, height }).toPNG();
  const hash = crypto.createHash("sha256").update(png).digest("hex").slice(0, 16);
  const file = path.join(iconCacheDir(), `${extensionId}-${hash}.png`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, png);
  return file;
}

export function extensionIcon(extension: LoadedExtension, size: number): string | null {
  const relative = pickIcon(manifestAction(extension.manifest)?.default_icon, size) ?? pickIcon(extension.manifest.icons, size);
  return relative ? resolveExtensionPath(extension.path, relative) : null;
}

export type ActionClickHandler = (window: ExtensionWindow, extension: LoadedExtension, tab: Tab) => boolean;

export class ActionStore {
  private readonly states = new Map<string, ActionState>();
  // Get first say over an icon click; returning true means the click was handled.
  readonly clickHandlers: ActionClickHandler[] = [];

  constructor(private readonly service: ExtensionService) {}

  extensionLoaded(extension: LoadedExtension) {
    const action = manifestAction(extension.manifest);
    this.states.set(extension.id, {
      defaults: {
        title: action?.default_title ?? extension.name,
        icon: extensionIcon(extension, TOOLBAR_ICON_PX),
        popup: action?.default_popup ? extension.url(action.default_popup) : "",
        badgeText: "",
        badgeBackground: null,
        badgeColor: null,
        enabled: !extension.manifest.page_action,
      },
      tabs: new Map(),
    });
  }

  extensionUnloaded(id: string) {
    this.states.delete(id);
  }

  tabRemoved(tabId: number) {
    for (const state of this.states.values()) state.tabs.delete(tabId);
  }

  tabNavigated(tab: Tab, urlChanged: boolean) {
    if (!urlChanged || tab.contentsId === null) return;
    let changed = false;
    for (const state of this.states.values()) {
      const fields = state.tabs.get(tab.contentsId);
      if (!fields) continue;
      const { badgeText: _text, title: _title, icon: _icon, ...kept } = fields;
      state.tabs.set(tab.contentsId, kept);
      changed = true;
    }
    if (changed) this.service.changed();
  }

  tabActivated(_window: ExtensionWindow) {
    this.service.changed();
  }

  private state(id: string): ActionState {
    const state = this.states.get(id);
    if (!state) throw new Error("Extension has no action");
    return state;
  }

  resolved(id: string, tabId: number | null): ActionFields {
    const state = this.state(id);
    const override = tabId !== null ? state.tabs.get(tabId) : undefined;
    return { ...state.defaults, ...override };
  }

  private set(caller: Caller, tabId: unknown, change: Partial<ActionFields>) {
    const state = this.state(caller.extension.id);
    if (typeof tabId === "number") {
      if (!this.service.tabRef(tabId) && !this.service.popupWindowForContents(tabId)) throw new Error(`No tab with id: ${tabId}.`);
      state.tabs.set(tabId, { ...state.tabs.get(tabId), ...change });
    } else {
      state.defaults = { ...state.defaults, ...change };
      for (const [id, fields] of state.tabs) {
        for (const key of Object.keys(change) as (keyof ActionFields)[]) delete fields[key];
        state.tabs.set(id, fields);
      }
    }
    this.service.changed();
  }

  toolbar(window: ExtensionWindow): ToolbarAction[] {
    const active = window.host.tabs.active;
    const tabId = active?.contentsId ?? null;
    const actions: ToolbarAction[] = [];
    for (const extension of this.service.loaded.values()) {
      if (!this.states.has(extension.id)) continue;
      const fields = this.resolved(extension.id, tabId);
      actions.push({
        extensionId: extension.id,
        name: extension.name,
        title: fields.title,
        icon: fields.icon,
        badge: fields.badgeText
          ? { text: fields.badgeText, background: fields.badgeBackground ?? DEFAULT_BADGE, color: fields.badgeColor ?? [255, 255, 255, 255] }
          : null,
        enabled: fields.enabled,
        pinned: extension.record.pinned,
        hasPopup: fields.popup !== "",
      });
    }
    return actions;
  }

  setPinned(id: string, pinned: boolean) {
    const extension = this.service.get(id);
    if (!extension) return;
    const record = updateExtension(id, { pinned });
    if (record) extension.record = record;
    this.service.changed();
  }

  // The user clicked the toolbar icon (or pressed the action's shortcut).
  activate(window: ExtensionWindow, id: string) {
    const extension = this.service.get(id);
    const tab = window.host.tabs.active;
    if (!extension || !tab) return;
    const fields = this.resolved(id, tab.contentsId);
    if (!fields.enabled) return;
    this.service.grantActiveTab(extension, tab);
    if (this.clickHandlers.some((handler) => handler(window, extension, tab))) return;
    if (fields.popup) {
      window.host.openActionPopup(id, fields.popup);
      return;
    }
    const ref = { window, tab };
    this.service.dispatch(id, "action.onClicked", [this.service.tabInfo(extension, ref)]);
  }

  install(service: ExtensionService) {
    const router = service.router;
    const tabArg = (details: unknown) => (details as { tabId?: number } | undefined)?.tabId;
    router.handle("action.setTitle", (caller, details) => {
      const { title, tabId } = details as { title: string; tabId?: number };
      this.set(caller, tabId, { title: String(title ?? "") });
    });
    router.handle("action.getTitle", (caller, details) => this.resolved(caller.extension.id, tabArg(details) ?? null).title);
    router.handle("action.setIcon", (caller, details) => {
      const { imageData, path: iconPath, tabId } = details as {
        imageData?: { width: number; height: number; data: Uint8Array } | Record<string, { width: number; height: number; data: Uint8Array }>;
        path?: string | Record<string, string>;
        tabId?: number;
      };
      type Bitmap = { width: number; height: number; data: Uint8Array };
      let icon: string | null = null;
      if (imageData) {
        const bitmaps: Bitmap[] =
          "data" in imageData ? [imageData as Bitmap] : Object.values(imageData as Record<string, Bitmap>);
        const largest = bitmaps.sort((a, b) => b.width - a.width)[0];
        if (!largest) throw new Error("Icon invalid.");
        icon = writeImageData(caller.extension.id, { ...largest, data: new Uint8Array(largest.data) });
      } else if (iconPath) {
        const picked = pickIcon(iconPath, TOOLBAR_ICON_PX);
        const relative = picked?.startsWith(caller.extension.baseUrl)
          ? decodeURIComponent(new URL(picked).pathname)
          : picked;
        icon = relative ? resolveExtensionPath(caller.extension.path, relative) : null;
        if (!icon || !fs.existsSync(icon)) throw new Error(`Failed to set icon '${picked}'`);
      } else {
        throw new Error("Icon invalid.");
      }
      this.set(caller, tabId, { icon });
    });
    router.handle("action.setPopup", (caller, details) => {
      const { popup, tabId } = details as { popup: string; tabId?: number };
      const url = popup ? caller.extension.url(String(popup)) : "";
      if (url && !url.startsWith(caller.extension.baseUrl)) throw new Error("Invalid popup url.");
      this.set(caller, tabId, { popup: url });
    });
    router.handle("action.getPopup", (caller, details) => this.resolved(caller.extension.id, tabArg(details) ?? null).popup);
    router.handle("action.setBadgeText", (caller, details) => {
      const { text, tabId } = details as { text?: string | null; tabId?: number };
      this.set(caller, tabId, { badgeText: text == null ? "" : String(text) });
    });
    router.handle("action.getBadgeText", (caller, details) => this.resolved(caller.extension.id, tabArg(details) ?? null).badgeText);
    router.handle("action.setBadgeBackgroundColor", (caller, details) => {
      const { color, tabId } = details as { color: unknown; tabId?: number };
      const parsed = parseColor(color);
      if (!parsed) throw new Error("The color specification could not be parsed.");
      this.set(caller, tabId, { badgeBackground: parsed });
    });
    router.handle("action.getBadgeBackgroundColor", (caller, details) => this.resolved(caller.extension.id, tabArg(details) ?? null).badgeBackground ?? DEFAULT_BADGE);
    router.handle("action.setBadgeTextColor", (caller, details) => {
      const { color, tabId } = details as { color: unknown; tabId?: number };
      const parsed = parseColor(color);
      if (!parsed) throw new Error("The color specification could not be parsed.");
      this.set(caller, tabId, { badgeColor: parsed });
    });
    router.handle("action.getBadgeTextColor", (caller, details) => this.resolved(caller.extension.id, tabArg(details) ?? null).badgeColor ?? [255, 255, 255, 255]);
    router.handle("action.enable", (caller, tabId) => this.set(caller, tabId, { enabled: true }));
    router.handle("action.disable", (caller, tabId) => this.set(caller, tabId, { enabled: false }));
    router.handle("action.isEnabled", (caller, tabId) => this.resolved(caller.extension.id, typeof tabId === "number" ? tabId : null).enabled);
    router.handle("action.getUserSettings", (caller) => ({ isOnToolbar: caller.extension.record.pinned }));
    router.handle("action.openPopup", (caller, options) => {
      const windowId = (options as { windowId?: number } | undefined)?.windowId;
      const window = service.resolveWindowId(caller, windowId);
      if (!window) throw new Error(`No window with id: ${windowId}.`);
      const tab = window.host.tabs.active;
      const fields = this.resolved(caller.extension.id, tab?.contentsId ?? null);
      if (!fields.popup) throw new Error("Extension does not have a popup on the active tab.");
      window.host.openActionPopup(caller.extension.id, fields.popup);
    });
  }
}
