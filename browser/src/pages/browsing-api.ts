import fs from "node:fs";

import { recentVisits } from "shared";

import { browsing } from "../browsing";
import type { BookmarkNode } from "../browsing/bookmarks";
import { isInternalUrl } from "./internal";
import type { InternalHandlers } from "./internal";
import { openFromPage } from "./open";
import { tabForContents } from "./tabs";

const PAGE_SIZE = 150;

function asNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid argument");
  return value;
}

function asString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid argument");
  return value;
}

export function historyHandlers(): InternalHandlers["history"] {
  const { history } = browsing();
  return {
    list: (_sender, options) => {
      const { text, before } = (options ?? {}) as { text?: unknown; before?: unknown };
      const visits = recentVisits({
        text: typeof text === "string" ? text : "",
        before: typeof before === "number" ? before : undefined,
        limit: PAGE_SIZE,
      });
      return {
        visits: visits.map((visit) => ({ url: visit.url, title: visit.title, time: visit.visitTime })),
        more: visits.length === PAGE_SIZE,
      };
    },
    remove: (_sender, url, start, end) => history.deleteUrlInRange(asString(url), asNumber(start), asNumber(end)),
    open: (sender, url, newTab) => openFromPage(sender, asString(url), newTab === true),
  };
}

export function downloadsHandlers(): InternalHandlers["downloads"] {
  const { downloads } = browsing();
  const id = asNumber;
  return {
    list: () =>
      downloads.list().map((record) => ({
        ...record,
        canResume: downloads.canResume(record.id),
        exists: record.state !== "complete" || fs.existsSync(record.filename),
      })),
    open: (_sender, download) => downloads.open(id(download)),
    show: (_sender, download) => downloads.show(id(download)),
    cancel: (_sender, download) => downloads.cancel(id(download)),
    pause: (_sender, download) => downloads.pause(id(download)),
    resume: (_sender, download) => downloads.resume(id(download)),
    remove: (_sender, download) => downloads.erase(id(download)),
    clear: () => {
      for (const record of downloads.list()) if (record.state !== "in_progress") downloads.erase(record.id);
    },
    openUrl: (sender, url) => openFromPage(sender, asString(url), true),
  };
}

// The tab the user was on before opening the bookmarks page.
function lastOtherTab(sender: Electron.WebContents) {
  const ref = tabForContents(sender.id);
  if (!ref) return null;
  const others = ref.tabs
    .all()
    .filter((tab) => tab !== ref.tab && tab.state.url && !isInternalUrl(tab.state.url))
    .sort((a, b) => b.lastAccessed - a.lastAccessed);
  return others[0] ?? null;
}

export function bookmarksHandlers(): InternalHandlers["bookmarks"] {
  const { bookmarks } = browsing();
  const tree = (sender: Electron.WebContents) => {
    const last = lastOtherTab(sender);
    const roots: BookmarkNode[] = bookmarks.tree()[0].children ?? [];
    return { roots, current: last ? { url: last.state.url, title: last.state.title } : null };
  };
  return {
    tree: (sender) => tree(sender),
    add: (_sender, details) => {
      const { parentId, title, url } = (details ?? {}) as { parentId?: unknown; title?: unknown; url?: unknown };
      bookmarks.create({ parentId: asString(parentId), title: asString(title), url: asString(url) });
    },
    addFolder: (_sender, details) => {
      const { parentId, title } = (details ?? {}) as { parentId?: unknown; title?: unknown };
      bookmarks.create({ parentId: asString(parentId), title: asString(title) });
    },
    remove: (_sender, id) => bookmarks.remove(asString(id), true),
    open: (sender, url, newTab) => openFromPage(sender, asString(url), newTab === true),
  };
}
