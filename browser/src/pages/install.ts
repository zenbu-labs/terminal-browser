import { browsing } from "../browsing";
import type { ExtensionService } from "../extensions/service";
import { bookmarksHandlers, downloadsHandlers, historyHandlers } from "./browsing-api";
import { extensionsHandlers } from "./extensions-api";
import { installInternalApi, pageNotifier } from "./internal";
import { guardInternalNavigation } from "./navigation";
import type { PageContext } from "./scheme";
import { settingsHandlers, watchSettingsForPages } from "./settings-api";
import { startPageData } from "./start";

export function installPages(service: ExtensionService, context: () => PageContext) {
  const data = () => startPageData(context().cwd);
  installInternalApi(
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
  service.onChange(pageNotifier("extensions"));
  history.changed.add(pageNotifier("history"));
  downloads.progressed.add(pageNotifier("downloads"));
  bookmarks.any.add(pageNotifier("bookmarks"));
  watchSettingsForPages();
  guardInternalNavigation();
}
