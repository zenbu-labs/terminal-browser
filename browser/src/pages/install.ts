import { session as electronSession } from "electron";

import { browsing } from "../browsing";
import type { ExtensionService } from "../extensions/service";
import { bookmarksHandlers, downloadsHandlers, historyHandlers } from "./browsing-api";
import { extensionsHandlers } from "./extensions-api";
import { installInternalApi, notifyPages } from "./internal";
import type { InternalHost } from "./internal-api";
import { guardInternalNavigation } from "./navigation";
import type { PageContext } from "./scheme";
import { settingsHandlers, watchSettingsForPages } from "./settings-api";
import { startPageData } from "./start";

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

export function installPages(service: ExtensionService, context: () => PageContext) {
  const data = () => startPageData(context().cwd);
  installInternalApi(
    electronSession.defaultSession,
    {
      start: { data },
      newtab: { data },
      extensions: extensionsHandlers(),
      history: historyHandlers(),
      downloads: downloadsHandlers(),
      bookmarks: bookmarksHandlers(),
      settings: settingsHandlers(),
    },
    (contents) => service.tabRef(contents.id) !== null,
  );
  const { history, downloads, bookmarks } = browsing();
  service.onChange(throttledNotify("extensions"));
  history.changed.add(throttledNotify("history"));
  downloads.progressed.add(throttledNotify("downloads"));
  bookmarks.any.add(throttledNotify("bookmarks"));
  watchSettingsForPages();
  guardInternalNavigation();
}
