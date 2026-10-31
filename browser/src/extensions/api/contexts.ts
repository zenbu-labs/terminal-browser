import crypto from "node:crypto";

import { webContents } from "electron";
import type { WebContents, WebFrameMain } from "electron";

import type { LoadedExtension } from "../loaded";
import type { ExtensionService } from "../service";
import { frameIdOf } from "./web-navigation";

type ContextType = "TAB" | "POPUP" | "BACKGROUND" | "OFFSCREEN_DOCUMENT" | "SIDE_PANEL";

interface ExtensionContext {
  contextType: ContextType;
  contextId: string;
  tabId: number;
  windowId: number;
  documentId?: string;
  frameId: number;
  documentUrl?: string;
  documentOrigin?: string;
  incognito: boolean;
}

interface ContextFilter {
  contextTypes?: string[];
  contextIds?: string[];
  tabIds?: number[];
  windowIds?: number[];
  documentIds?: string[];
  frameIds?: number[];
  documentUrls?: string[];
  documentOrigins?: string[];
  incognito?: boolean;
}

interface DocumentIds {
  key: string;
  contextId: string;
  documentId: string;
}

const UNKNOWN_ID = -1;

function matches(context: ExtensionContext, filter: ContextFilter): boolean {
  const within = <T>(list: T[] | undefined, value: T | undefined) =>
    !list || (value !== undefined && list.includes(value));
  return (
    within(filter.contextTypes, context.contextType) &&
    within(filter.contextIds, context.contextId) &&
    within(filter.tabIds, context.tabId) &&
    within(filter.windowIds, context.windowId) &&
    within(filter.documentIds, context.documentId) &&
    within(filter.frameIds, context.frameId) &&
    within(filter.documentUrls, context.documentUrl) &&
    within(filter.documentOrigins, context.documentOrigin) &&
    (filter.incognito === undefined || filter.incognito === context.incognito)
  );
}

// Chromium's own runtime.getContexts can't tell what our tabs, popups and side
// panels are, so it skips them (and aborts in debug builds).
export function installContexts(service: ExtensionService) {
  const documents = new WeakMap<WebFrameMain, DocumentIds>();
  const workers = new Map<number, string>();

  const idsFor = (frame: WebFrameMain): DocumentIds => {
    const key = `${frame.processId}:${frame.routingId}:${frame.url}`;
    const known = documents.get(frame);
    if (known?.key === key) return known;
    const ids = { key, contextId: crypto.randomUUID(), documentId: crypto.randomBytes(16).toString("hex").toUpperCase() };
    documents.set(frame, ids);
    return ids;
  };

  const placement = (contents: WebContents): { type: ContextType; tabId: number; windowId: number } | null => {
    const tab = service.tabRef(contents.id);
    if (tab) return { type: "TAB", tabId: contents.id, windowId: tab.window.id };
    const popupWindow = service.popupWindowForContents(contents.id);
    if (popupWindow) return { type: "TAB", tabId: contents.id, windowId: popupWindow.id };
    const surface = service.surface(contents.id);
    if (surface) return { type: surface.kind === "side-panel" ? "SIDE_PANEL" : "POPUP", tabId: UNKNOWN_ID, windowId: UNKNOWN_ID };
    // Chromium hosts offscreen documents itself; Electron reports them as "remote".
    if (contents.getType() === "remote") return { type: "OFFSCREEN_DOCUMENT", tabId: UNKNOWN_ID, windowId: UNKNOWN_ID };
    return null;
  };

  const frameContexts = (extension: LoadedExtension): ExtensionContext[] => {
    const origin = extension.baseUrl.replace(/\/$/, "");
    const contexts: ExtensionContext[] = [];
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed() || contents.session !== service.session) continue;
      const place = placement(contents);
      if (!place) continue;
      for (const frame of contents.mainFrame.framesInSubtree) {
        if (frame.isDestroyed() || frame.origin !== origin) continue;
        const ids = idsFor(frame);
        contexts.push({
          contextType: place.type,
          contextId: ids.contextId,
          tabId: place.tabId,
          windowId: place.windowId,
          documentId: ids.documentId,
          frameId: frameIdOf(frame),
          documentUrl: frame.url,
          documentOrigin: origin,
          incognito: false,
        });
      }
    }
    return contexts;
  };

  const workerContext = (extension: LoadedExtension): ExtensionContext | null => {
    const running = Object.values(service.session.serviceWorkers.getAllRunning());
    for (const versionId of workers.keys()) if (!running.some((info) => info.versionId === versionId)) workers.delete(versionId);
    const worker = running.find((info) => info.scope === extension.baseUrl);
    if (!worker) return null;
    let contextId = workers.get(worker.versionId);
    if (!contextId) workers.set(worker.versionId, (contextId = crypto.randomUUID()));
    return { contextType: "BACKGROUND", contextId, tabId: UNKNOWN_ID, windowId: UNKNOWN_ID, frameId: -1, incognito: false };
  };

  service.router.handle("runtime.getContexts", (caller, filter) => {
    if (typeof filter !== "object" || filter === null || Array.isArray(filter)) {
      throw new Error("Error in invocation of runtime.getContexts(runtime.ContextFilter filter, optional function callback): No matching signature.");
    }
    const worker = workerContext(caller.extension);
    const contexts = [...(worker ? [worker] : []), ...frameContexts(caller.extension)];
    return contexts.filter((context) => matches(context, filter as ContextFilter));
  });
}
