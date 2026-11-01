import type { WebContents, WebFrameMain } from "electron";

import { frameDocumentId } from "../extensions/native";
import { isInternalUrl } from "./internal";

// Whether the browser itself opened a page: its UI, menus, the CLI, or a link on one of its own pages. Anything else
// (an extension, a reload, back/forward) doesn't count. Each navigation is judged as it starts, and the verdict
// belongs to the one document it commits.
type Source = "browser" | "first-load" | null;

const browserTabs = new WeakSet<WebContents>();
const browserStarting = new WeakSet<WebContents>();
const loaded = new WeakSet<WebContents>();
const starting = new WeakMap<WebContents, { url: string; source: Source }>();
const committed = new WeakMap<WebContents, { documentId: string; source: Source }>();

// A tab the browser opened: the first page it loads counts as the browser's.
export function openedAsBrowserTab(contents: WebContents) {
  browserTabs.add(contents);
}

// Loads `url` in `contents` as the browser's own navigation, e.g. a URL the user typed.
export function navigateAsBrowser(contents: WebContents, navigate: () => void) {
  browserStarting.add(contents);
  try {
    navigate();
  } finally {
    browserStarting.delete(contents);
  }
}

function sourceOf(contents: WebContents, initiator: WebFrameMain | null): Source {
  if (browserStarting.has(contents)) return "browser";
  if (initiator) {
    try {
      return isInternalUrl(initiator.origin) ? "browser" : null;
    } catch {
      return null;
    }
  }
  return loaded.has(contents) ? null : "first-load";
}

export function trackInternalPageOpener(contents: WebContents) {
  contents.on("did-start-navigation", (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    starting.set(contents, { url: details.url, source: sourceOf(contents, details.initiator ?? null) });
    loaded.add(contents);
  });
  contents.on("did-navigate", (_event, url) => {
    const navigation = starting.get(contents);
    starting.delete(contents);
    const source = navigation?.url === url ? navigation.source : null;
    committed.set(contents, { documentId: frameDocumentId(contents.mainFrame), source });
  });
}

export function pageOpenedByBrowser(contents: WebContents): boolean {
  const page = committed.get(contents);
  if (!page || page.documentId !== frameDocumentId(contents.mainFrame)) return false;
  return page.source === "browser" || (page.source === "first-load" && browserTabs.has(contents));
}
