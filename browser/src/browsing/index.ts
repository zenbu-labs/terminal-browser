import { Bookmarks } from "./bookmarks";
import { RecentlyClosed } from "./closed";
import { DownloadManager } from "./downloads";
import { HistoryRecorder } from "./history";

export interface Browsing {
  history: HistoryRecorder;
  downloads: DownloadManager;
  bookmarks: Bookmarks;
  closed: RecentlyClosed;
}

let instance: Browsing | null = null;

export function startBrowsing(): Browsing {
  if (instance) return instance;
  instance = {
    history: new HistoryRecorder(),
    downloads: new DownloadManager(),
    bookmarks: new Bookmarks(),
    closed: new RecentlyClosed(),
  };
  instance.history.start();
  instance.downloads.start();
  return instance;
}

export function browsing(): Browsing {
  if (!instance) throw new Error("browsing data has not started");
  return instance;
}
