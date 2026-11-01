import type { WebContents } from "electron";

import { extensionService } from "../extensions/service";
import { normalizeUrl } from "../url";

const OPENABLE = /^(?:https?|file|ftp|chrome-extension|terminal-browser-file):/i;

// Opens a link a page listed (a history entry, a download's source) the way a
// click in the omnibox would, so file urls and markdown work too.
export function openFromPage(sender: WebContents, raw: string, newTab: boolean) {
  const url = normalizeUrl(raw, undefined, (query) => query);
  if (!OPENABLE.test(url)) throw new Error("Invalid URL");
  const ref = extensionService().tabRef(sender.id);
  if (!ref) throw new Error("Not allowed");
  if (!newTab) {
    void sender.loadURL(url);
    return;
  }
  const tabs = ref.window.host.tabs;
  tabs.create(url, true, { index: tabs.all().indexOf(ref.tab) + 1, openerId: ref.tab.id });
}
