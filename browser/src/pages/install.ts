import { session as electronSession } from "electron";

import { browsing } from "../browsing";
import { bookmarksHandlers, downloadsHandlers, historyHandlers } from "./browsing-api";
import { installInternalApi, notifyPages } from "./internal";
import type { InternalHost } from "./internal-api";
import { guardInternalNavigation } from "./navigation";
import type { PageContext } from "./scheme";
import { settingsHandlers, watchSettingsForPages } from "./settings-api";
import { startPageData } from "./start";
import { tabForContents } from "./tabs";

const NOTIFY_MS = 250;

function throttledNotify(host: InternalHost): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    timer ??= setTimeout(() => {
      timer = null;
      notifyPages(host);
    }, NOTIFY_MS);
  };
}

export function installPages(context: () => PageContext) {
  const data = () => startPageData(context().cwd);
  installInternalApi(
    electronSession.defaultSession,
    {
      start: { data },
      newtab: { data },
      history: historyHandlers(),
      downloads: downloadsHandlers(),
      bookmarks: bookmarksHandlers(),
      settings: settingsHandlers(),
    },
    (contents) => tabForContents(contents.id) !== null,
  );
  const { history, downloads, bookmarks } = browsing();
  history.changed.add(throttledNotify("history"));
  downloads.progressed.add(throttledNotify("downloads"));
  bookmarks.any.add(throttledNotify("bookmarks"));
  watchSettingsForPages();
  guardInternalNavigation();
}
