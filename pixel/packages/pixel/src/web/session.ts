import fs from "node:fs";
import path from "node:path";

import { app, ipcMain } from "electron";
import type { IpcMainEvent, Session } from "electron";

import { configureBrowserSession } from "./browser-session";
import type { PageHost } from "./host";

export interface TerminalTheme {
  background: number[];
  foreground: number[];
  ansi: (number[] | null)[];
}

export const THEME_CHANNEL = "pixel:theme";
export const THEME_REQUEST_CHANNEL = "pixel:theme-request";
export const QUIT_CHANNEL = "pixel:quit";

// library into an app keeps working.
const API_PRELOAD_SOURCE = `if (process.isMainFrame) {
  const { ipcRenderer } = require("electron");
  let current = null;
  const subscribers = new Set();
  ipcRenderer.on("pixel:theme", (_event, theme) => {
    current = theme;
    for (const subscriber of subscribers) {
      try { subscriber(theme); } catch {}
    }
  });
  ipcRenderer.send("pixel:theme-request");
  globalThis.pixel = {
    theme: () => current,
    onTheme(subscriber) {
      subscribers.add(subscriber);
      if (current) { try { subscriber(current); } catch {} }
      return () => subscribers.delete(subscriber);
    },
    quit: () => ipcRenderer.send("pixel:quit"),
  };
}
`;

let apiPreloadFile: string | null = null;
function apiPreloadPath(): string {
  if (!apiPreloadFile) {
    apiPreloadFile = path.join(app.getPath("userData"), "pixel-api-preload.js");
    fs.writeFileSync(apiPreloadFile, API_PRELOAD_SOURCE);
  }
  return apiPreloadFile;
}

const prepared = new Set<Session>();

export function prepareSession(ses: Session): void {
  if (prepared.has(ses)) return;
  prepared.add(ses);
  configureBrowserSession(ses);
  ses.registerPreloadScript({ type: "frame", filePath: apiPreloadPath() });
}

export function flushSessions(): void {
  for (const ses of prepared) {
    try {
      ses.flushStorageData();
    } catch {}
  }
}

export interface EmbedderHost {
  hosts(): Iterable<PageHost>;
  theme(): TerminalTheme | null;
  quit(host: PageHost): void;
}


const embedders = new Set<EmbedderHost>();

function ownerOf(event: IpcMainEvent): { embedder: EmbedderHost; host: PageHost } | null {
  if (event.senderFrame !== event.sender.mainFrame) return null;
  for (const embedder of embedders) {
    for (const host of embedder.hosts()) {
      if (host.hasContents(event.sender.id)) return { embedder, host };
    }
  }
  return null;
}

function onThemeRequest(event: IpcMainEvent) {
  const owner = ownerOf(event);
  if (!owner) return;
  const payload = owner.embedder.theme();
  if (payload) event.sender.send(THEME_CHANNEL, payload);
}

function onQuitRequest(event: IpcMainEvent) {
  const owner = ownerOf(event);
  if (owner) owner.embedder.quit(owner.host);
}

export function installEmbedderApi(target: EmbedderHost): void {
  if (embedders.size === 0) {
    ipcMain.on(THEME_REQUEST_CHANNEL, onThemeRequest);
    ipcMain.on(QUIT_CHANNEL, onQuitRequest);
  }
  embedders.add(target);
}

export function uninstallEmbedderApi(target: EmbedderHost): void {
  embedders.delete(target);
  if (embedders.size === 0) {
    ipcMain.removeListener(THEME_REQUEST_CHANNEL, onThemeRequest);
    ipcMain.removeListener(QUIT_CHANNEL, onQuitRequest);
  }
}

export function broadcastTheme(target: EmbedderHost, theme: TerminalTheme | null): void {
  if (!theme) return;
  for (const host of target.hosts()) host.sendToPage(THEME_CHANNEL, theme);
}
