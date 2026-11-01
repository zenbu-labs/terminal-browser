import fs from "node:fs";
import path from "node:path";

import { ipcMain, webContents as allWebContents } from "electron";
import type { IpcMainInvokeEvent, Session, WebContents } from "electron";

import { INTERNAL_API, INTERNAL_CHANGED_CHANNEL, internalChannel } from "./internal-api";
import type { InternalHost } from "./internal-api";

export type InternalHandler = (sender: WebContents, ...args: unknown[]) => unknown;

export type InternalHandlers = { [H in InternalHost]: Record<(typeof INTERNAL_API)[H][number], InternalHandler> };

export const INTERNAL_SCHEME = "terminal-browser";

function preloadPath(): string {
  const candidates = [path.join(__dirname, "..", "internal-preload.js"), path.join(__dirname, "internal-preload.js")];
  const found = candidates.find((file) => fs.existsSync(file));
  if (!found) throw new Error(`internal page preload missing (looked in ${candidates.join(", ")})`);
  return found;
}

export function isInternalUrl(url: string): boolean {
  return /^terminal-browser:/i.test(url.trim());
}

export function internalHostOf(url: string): string | null {
  if (!isInternalUrl(url)) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

// Like Chrome's WebUI: a call is answered only for the top frame of one of our
// tabs whose committed origin is exactly the page that owns the method.
function allowed(event: IpcMainInvokeEvent, host: InternalHost, session: Session, isTab: (contents: WebContents) => boolean) {
  const frame = event.senderFrame;
  return (
    frame !== null &&
    frame.parent === null &&
    frame === event.sender.mainFrame &&
    frame.origin === `${INTERNAL_SCHEME}://${host}` &&
    event.sender.session === session &&
    isTab(event.sender)
  );
}

export function installInternalApi(session: Session, handlers: InternalHandlers, isTab: (contents: WebContents) => boolean) {
  session.registerPreloadScript({ type: "frame", filePath: preloadPath() });
  for (const host of Object.keys(INTERNAL_API) as InternalHost[]) {
    const pageHandlers = handlers[host] as Record<string, InternalHandler>;
    for (const method of INTERNAL_API[host]) {
      ipcMain.handle(internalChannel(host, method), (event, ...args) => {
        if (!allowed(event, host, session, isTab)) throw new Error("Not allowed");
        return pageHandlers[method](event.sender, ...args);
      });
    }
  }
}

export function notifyPages(...hosts: InternalHost[]) {
  for (const contents of allWebContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue;
    const host = internalHostOf(contents.getURL());
    if (host && (hosts as string[]).includes(host)) contents.send(INTERNAL_CHANGED_CHANNEL);
  }
}
