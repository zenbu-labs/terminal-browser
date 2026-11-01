import fs from "node:fs";
import path from "node:path";

import { ipcMain, webContents as allWebContents } from "electron";
import type { IpcMainInvokeEvent, Session, WebContents } from "electron";

import { canonicalUrl } from "../canonical-url";
import { INTERNAL_API, INTERNAL_CHANGED_CHANNEL, internalChannel } from "./internal-api";
import type { InternalHost } from "./internal-api";
import { forEverySession } from "./sessions";

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
  return canonicalUrl(url)?.scheme === INTERNAL_SCHEME || /^terminal-browser:/i.test(url.trim());
}

export function internalHostOf(url: string): string | null {
  const parsed = canonicalUrl(url);
  return parsed?.scheme === INTERNAL_SCHEME ? parsed.host : null;
}

// Like Chrome's WebUI: a call is answered only for the top frame of one of our
// tabs whose committed origin is exactly the page that owns the method.
export function allowedInternalCall(
  event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
  host: InternalHost,
  servedSession: (session: Session) => boolean,
  isTab: (contents: WebContents) => boolean,
): boolean {
  const frame = event.senderFrame;
  return (
    frame !== null &&
    frame.parent === null &&
    frame === event.sender.mainFrame &&
    frame.origin === `${INTERNAL_SCHEME}://${host}` &&
    servedSession(event.sender.session) &&
    isTab(event.sender)
  );
}

export function installInternalApi(handlers: InternalHandlers, isTab: (contents: WebContents) => boolean) {
  const preload = preloadPath();
  const servedSession = forEverySession((session) => session.registerPreloadScript({ type: "frame", filePath: preload }));
  for (const host of Object.keys(INTERNAL_API) as InternalHost[]) {
    const pageHandlers = handlers[host] as Record<string, InternalHandler>;
    for (const method of INTERNAL_API[host]) {
      ipcMain.handle(internalChannel(host, method), (event, ...args) => {
        if (!allowedInternalCall(event, host, servedSession, isTab)) throw new Error("Not allowed");
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

export const PAGE_NOTIFY_MS = 250;

// A change after a quiet spell reaches open pages at once; a burst of changes,
// like download progress, reaches them at most once every PAGE_NOTIFY_MS.
export function pageNotifier(host: InternalHost): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let quietAt = 0;
  return () => {
    timer ??= setTimeout(
      () => {
        timer = null;
        quietAt = Date.now() + PAGE_NOTIFY_MS;
        notifyPages(host);
      },
      Math.max(0, quietAt - Date.now()),
    );
  };
}
