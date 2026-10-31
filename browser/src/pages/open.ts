import type { WebContents } from "electron";

import { normalizeUrl } from "../url";
import { tabForContents } from "./tabs";

const OPENABLE = /^(?:https?|file|ftp|terminal-browser-file):/i;

// Opens a link a page listed (a history entry, a download's source) the way a
// click in the omnibox would, so file urls and markdown work too.
export function openFromPage(sender: WebContents, raw: string, newTab: boolean) {
  const url = normalizeUrl(raw, undefined, (query) => query);
  if (!OPENABLE.test(url)) throw new Error("Invalid URL");
  const ref = tabForContents(sender.id);
  if (!ref) throw new Error("Not allowed");
  if (!newTab) {
    void sender.loadURL(url);
    return;
  }
  ref.tabs.create(url, true, { index: ref.tabs.all().indexOf(ref.tab) + 1 });
}
