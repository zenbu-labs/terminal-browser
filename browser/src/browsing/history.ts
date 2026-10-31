import { app } from "electron";
import type { WebContents } from "electron";

import {
  addHistoryVisit,
  deleteAllHistory,
  deleteHistoryRange,
  deleteHistoryUrl,
  deleteHistoryUrlInRange,
  setHistoryTitle,
} from "shared";
import type { HistoryEntry } from "shared";

import { DOC_SCHEME } from "../url";
import { Listeners } from "./listeners";

export interface HistoryRemoval {
  allHistory: boolean;
  urls: string[];
}

const NOT_RECORDED = /^(?:terminal-browser|chrome-extension|chrome|devtools|about|data|blob|javascript|view-source):/i;
const TYPED_WINDOW_MS = 30_000;
const TAB_TYPES = new Set(["window", "offscreen"]);

// Markdown and html previews are local files, so history keeps the file:// url
// Chrome would have recorded for them.
export function historyUrl(url: string): string | null {
  if (!url || NOT_RECORDED.test(url)) return null;
  const doc = `${DOC_SCHEME}://file`;
  if (url.startsWith(doc)) return `file://${url.slice(doc.length)}`;
  return url;
}

export class HistoryRecorder {
  readonly visited = new Listeners<[HistoryEntry]>();
  readonly removed = new Listeners<[HistoryRemoval]>();
  readonly changed = new Listeners<[]>();
  private readonly typed = new Map<string, number>();

  start() {
    app.on("web-contents-created", (_event, contents) => {
      if (TAB_TYPES.has(contents.getType())) this.watch(contents);
    });
  }

  typedUrl(url: string) {
    this.typed.set(url, Date.now());
  }

  add(url: string, transition: string, title?: string, referringVisitId?: number | null): number | null {
    const recorded = historyUrl(url);
    if (!recorded) return null;
    const { entry, visitId } = addHistoryVisit({ url: recorded, title, transition, referringVisitId });
    this.visited.emit(entry);
    this.changed.emit();
    return visitId;
  }

  deleteUrl(url: string) {
    if (!deleteHistoryUrl(url)) return;
    this.removed.emit({ allHistory: false, urls: [url] });
    this.changed.emit();
  }

  deleteUrlInRange(url: string, startTime: number, endTime: number) {
    const urls = deleteHistoryUrlInRange(url, startTime, endTime);
    if (urls.length) this.removed.emit({ allHistory: false, urls });
    this.changed.emit();
  }

  deleteRange(startTime: number, endTime: number) {
    const urls = deleteHistoryRange(startTime, endTime);
    if (urls.length) this.removed.emit({ allHistory: false, urls });
    this.changed.emit();
  }

  deleteAll() {
    deleteAllHistory();
    this.removed.emit({ allHistory: true, urls: [] });
    this.changed.emit();
  }

  private consumeTyped(url: string): boolean {
    const at = this.typed.get(url);
    this.typed.delete(url);
    for (const [typed, time] of this.typed) if (Date.now() - time > TYPED_WINDOW_MS) this.typed.delete(typed);
    return at !== undefined && Date.now() - at <= TYPED_WINDOW_MS;
  }

  private watch(contents: WebContents) {
    let committed = "";
    let lastVisit: number | null = null;
    let linkTarget: string | null = null;
    contents.on("will-navigate", (event) => {
      if (event.isMainFrame) linkTarget = event.url;
    });
    contents.on("did-navigate", (_event, url) => {
      const transition = this.consumeTyped(url)
        ? "typed"
        : url === committed && linkTarget !== url
          ? "reload"
          : "link";
      linkTarget = null;
      committed = url;
      const visit = this.add(url, transition, undefined, transition === "link" ? lastVisit : null);
      if (visit !== null) lastVisit = visit;
    });
    contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (!isMainFrame || url === committed) return;
      committed = url;
      const visit = this.add(url, "link", undefined, lastVisit);
      if (visit !== null) lastVisit = visit;
    });
    contents.on("page-title-updated", (_event, title) => {
      const url = historyUrl(contents.getURL());
      if (!url || !title) return;
      if (setHistoryTitle(url, title)) this.changed.emit();
    });
  }
}
