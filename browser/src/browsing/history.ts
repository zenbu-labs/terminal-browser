import { app, session as electronSession } from "electron";
import type { WebContents } from "electron";

import {
  ConfigStore,
  SETTINGS,
  SETTINGS_FILE,
  SHORTCUTS_FILE,
  addHistoryVisit,
  deleteAllHistory,
  deleteHistoryRange,
  deleteHistoryUrl,
  deleteHistoryUrlInRange,
  setHistoryTitle,
} from "shared";
import type { HistoryEntry, Settings } from "shared";

import { fileUrlForDocument } from "../url";
import { Listeners } from "./listeners";
import { committedFromAddressBar, watchTypedNavigations } from "./typed";

export interface HistoryRemoval {
  allHistory: boolean;
  urls: string[];
}

const NOT_RECORDED = /^(?:terminal-browser|chrome-extension|chrome|devtools|about|data|blob|javascript|view-source):/i;
const TITLES_PER_TAB = 50;
const TAB_TYPES = new Set(["window", "offscreen"]);

// Local files are shown as sandboxed documents, so history keeps the file:// url
// Chrome would have recorded for them; opening it shows the same sandboxed document.
export function historyUrl(url: string): string | null {
  if (!url || NOT_RECORDED.test(url)) return null;
  return fileUrlForDocument(url);
}

export class HistoryRecorder {
  readonly visited = new Listeners<[HistoryEntry]>();
  readonly removed = new Listeners<[HistoryRemoval]>();
  readonly changed = new Listeners<[]>();
  private readonly settings = new ConfigStore({ settings: SETTINGS_FILE, shortcuts: SHORTCUTS_FILE });
  private mode: Settings["history.record"] = SETTINGS["history.record"].default;

  start() {
    this.readMode();
    this.settings.watch(() => this.readMode());
    app.on("web-contents-created", (_event, contents) => {
      if (TAB_TYPES.has(contents.getType())) this.watch(contents);
    });
  }

  // SSH windows browse through their own session, so "local" leaves them out.
  private records(contents: WebContents): boolean {
    if (this.mode === "off") return false;
    return this.mode === "all" || contents.session === electronSession.defaultSession;
  }

  private readMode() {
    this.mode = this.settings.load().settings?.["history.record"] ?? SETTINGS["history.record"].default;
  }

  add(url: string, transition: string, title?: string, referringVisitId?: number | null): number | null {
    const recorded = historyUrl(url);
    if (!recorded || this.mode === "off") return null;
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

  private watch(contents: WebContents) {
    watchTypedNavigations(contents);
    let committed = "";
    let lastVisit: number | null = null;
    let linkTarget: string | null = null;
    // Chromium only reports a title when it changes, so a reload or a back/forward
    // restore of an already-titled page reports none; remember each page's title.
    const titles = new Map<string, string>();
    const remember = (url: string, title: string) => {
      titles.delete(url);
      titles.set(url, title);
      if (titles.size > TITLES_PER_TAB) titles.delete(titles.keys().next().value!);
    };
    contents.on("will-navigate", (event) => {
      if (event.isMainFrame) linkTarget = event.url;
    });
    contents.on("did-navigate", (_event, url) => {
      const transition = committedFromAddressBar(contents)
        ? "typed"
        : url === committed && linkTarget !== url
          ? "reload"
          : "link";
      linkTarget = null;
      committed = url;
      if (!this.records(contents)) return;
      const visit = this.add(url, transition, titles.get(url), transition === "link" ? lastVisit : null);
      if (visit !== null) lastVisit = visit;
    });
    contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (!isMainFrame || url === committed) return;
      const title = titles.get(committed);
      committed = url;
      if (title !== undefined) remember(url, title);
      if (!this.records(contents)) return;
      const visit = this.add(url, "link", title, lastVisit);
      if (visit !== null) lastVisit = visit;
    });
    // Without a <title> Chromium reports the url as an implicit title; history keeps "" like Chrome.
    contents.on("page-title-updated", (_event, title, explicitSet) => {
      if (!explicitSet || !title) return;
      const current = contents.getURL();
      remember(current, title);
      const url = historyUrl(current);
      if (!url || !this.records(contents)) return;
      if (setHistoryTitle(url, title)) this.changed.emit();
    });
  }
}
