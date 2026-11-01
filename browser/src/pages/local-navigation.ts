import type { DownloadItem, Session, WebContents, WebFrameMain } from "electron";

import { isInternalUrl } from "./internal";
import { activated, documentOf, isLocalDocument, localDocumentMayDownload, localDocumentMayOpen, withoutFragment } from "./local-files";

// Like Chrome's file:// pages, local documents open only from the browser, our own pages and other local documents.
function mayNavigateFrame(url: string, isMainFrame: boolean, initiator: WebFrameMain | null): boolean {
  if (!initiator || !isMainFrame) return false;
  const document = documentOf(initiator);
  if (isInternalUrl(document)) return true;
  return isLocalDocument(document) && localDocumentMayOpen(document, url, activated(initiator));
}

function mayDownloadFrom(initiator: WebFrameMain | null | undefined, url: string): boolean {
  if (!initiator) return true;
  const document = documentOf(initiator);
  return !isLocalDocument(document) || localDocumentMayDownload(document, url, activated(initiator));
}

const started = new WeakMap<WebContents, { url: string; mayDownload: boolean }>();
const openedWithoutDownload = new WeakMap<WebContents, string>();
const shown = new WeakMap<WebContents, string>();

export function guardLocalNavigation(contents: WebContents) {
  contents.on("will-frame-navigate", (event) => {
    if (!isLocalDocument(event.url)) return;
    let allowed = false;
    try {
      allowed = mayNavigateFrame(event.url, event.isMainFrame, event.initiator ?? null);
    } catch {}
    if (!allowed) event.preventDefault();
  });
  contents.on("did-start-navigation", (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    let mayDownload = false;
    try {
      mayDownload = mayDownloadFrom(details.initiator, details.url);
    } catch {}
    started.set(contents, { url: withoutFragment(details.url), mayDownload });
  });
  contents.on("did-navigate", (_event, url, code) => {
    openedWithoutDownload.delete(contents);
    if (isLocalDocument(url) && code >= 200 && code < 300) shown.set(contents, withoutFragment(url));
    else shown.delete(contents);
  });
}

// A tab a local document opened: its first page may show, but not turn into a download.
export function refuseDownloadOf(contents: WebContents, url: string) {
  openedWithoutDownload.set(contents, withoutFragment(url));
}

function downloadAllowed(contents: WebContents, item: DownloadItem): boolean {
  const url = withoutFragment(item.getURLChain()[0] ?? item.getURL());
  if (openedWithoutDownload.get(contents) === url) {
    openedWithoutDownload.delete(contents);
    return false;
  }
  const navigation = started.get(contents);
  if (navigation?.url === url) return navigation.mayDownload;
  const page = contents.mainFrame;
  return !isLocalDocument(page.url) || localDocumentMayDownload(page.url, url, activated(page));
}

export function guardLocalDownloads(session: Session) {
  session.prependListener("will-download", (event, item, contents) => {
    if (!contents || contents.isDestroyed()) return;
    let allowed = false;
    try {
      allowed = downloadAllowed(contents, item);
    } catch {}
    if (!allowed) event.preventDefault();
  });
}

// Whether a copy of the tab may load `url` as the browser: a local document only if the browser really showed it
// here, so a URL some page or extension only tried to open never gets loaded with the browser's rights.
export function browserMayReload(contents: WebContents | null | undefined, url: string): boolean {
  if (!isLocalDocument(url)) return true;
  return !!contents && shown.get(contents) === withoutFragment(url);
}
