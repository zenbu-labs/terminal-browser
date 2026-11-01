import type { WebContents, WebFrameMain } from "electron";

import { canonicalOrigin, canonicalUrl } from "../canonical-url";
import { recentPopupActivation } from "../extensions/user-activation";
import { DOC_SCHEME } from "../url";
import { INTERNAL_SCHEME } from "./internal";
import { localDocumentMayDownload, localDocumentMayOpen } from "./local-files";

// The tab we open for a page loads the URL itself instead of the page navigating, so the checks Chromium makes
// on a page's navigations are made here: a page may not open local files, our pages, or URLs it couldn't load.
const PAGE_BLOCKED_SCHEMES = new Set(["javascript", "data", "filesystem", "file", "view-source", "chrome", "chrome-untrusted", "devtools"]);
// Any other scheme belongs to another app: like Chrome, it opens no tab, and the user is asked before it's handed over.
const BROWSER_SCHEMES = new Set([...PAGE_BLOCKED_SCHEMES, "http", "https", "about", "blob", "chrome-extension", "ws", "wss", DOC_SCHEME, INTERNAL_SCHEME]);

export type Opener =
  | { kind: "internal" }
  // `activated`: the user clicked or typed in the document just before it asked
  | { kind: "local"; document: string; activated: boolean }
  | { kind: "page"; origin: string | null; site: string | null };

export interface WindowOpenRoute {
  url: string;
  // the origin the new tab's load runs as, or null for a load the browser makes
  initiator: string | null;
  byBrowser: boolean;
  // set for a URL another app opens: the origin the prompt names as asking
  external: { requester: string } | null;
  // false when the load may only show a page, not start a download
  mayDownload: boolean;
}

function trust(opener: Opener): number {
  if (opener.kind === "internal") return 4;
  if (opener.kind === "local") return 3;
  if (!opener.origin) return 0;
  return opener.origin.startsWith("chrome-extension://") ? 2 : 1;
}

// srcdoc and blank frames run with the origin of the document that made them.
function documentUrl(frame: WebFrameMain): string {
  let current: WebFrameMain | null = frame;
  while (current?.parent && /^about:(?:srcdoc|blank)/.test(current.url)) current = current.parent;
  return current?.url ?? "";
}

// Chrome names an opaque frame by the site that made it (its precursor origin): a sandboxed frame by its own URL,
// a data: or blob: frame by the frame that created it, and a local file as file://.
function siteOf(frame: WebFrameMain): string | null {
  if (frame.origin !== "null") return canonicalOrigin(frame.origin);
  const url = documentUrl(frame);
  if (/^(?:about|data|blob):/i.test(url)) return frame.parent ? siteOf(frame.parent) : null;
  if (url.startsWith(`${DOC_SCHEME}://`)) return "file://";
  return canonicalOrigin(url);
}

function openerOf(frame: WebFrameMain, activated: boolean): Opener {
  const origin = frame.origin === "null" ? null : canonicalOrigin(frame.origin);
  if (origin?.startsWith(`${INTERNAL_SCHEME}://`)) return { kind: "internal" };
  const document = documentUrl(frame);
  if (!origin && document.startsWith(`${DOC_SCHEME}://`)) return { kind: "local", document, activated };
  return { kind: "page", origin, site: siteOf(frame) };
}

function frames(contents: WebContents): WebFrameMain[] {
  try {
    return contents.mainFrame.framesInSubtree.filter((frame) => !frame.isDestroyed());
  } catch {
    return [];
  }
}

// Electron doesn't say which frame asked, so the referrer picks it out; without one (extension pages never
// send one), any frame of the page could have, and the least trusted of them decides.
export function openingFrames(contents: WebContents, details: Pick<Electron.HandlerDetails, "referrer">): WebFrameMain[] {
  const all = frames(contents);
  const referrer = details.referrer?.url ?? "";
  const referrerOrigin = referrer ? canonicalOrigin(referrer) : null;
  const sent = (frame: WebFrameMain) => canonicalOrigin(frame.origin === "null" ? documentUrl(frame) : frame.origin) === referrerOrigin;
  const named = referrerOrigin ? all.filter(sent) : [];
  return named.length > 0 ? named : all;
}

function openingFrame(contents: WebContents, details: Pick<Electron.HandlerDetails, "referrer">): Opener | null {
  const frames = openingFrames(contents, details);
  const activated = recentPopupActivation(contents, frames);
  const candidates = frames.map((frame) => ({ frame, opener: openerOf(frame, activated) }));
  if (candidates.length === 0) return null;
  const decided = candidates
    .map(({ opener }) => opener)
    .reduce((least, opener) => {
      if (trust(opener) !== trust(least)) return trust(opener) < trust(least) ? opener : least;
      return least.kind === "page" && opener.kind === "page" && least.origin !== opener.origin ? { kind: "page", origin: null, site: null } : least;
    });
  if (decided.kind !== "page") return decided;
  // When any of several frames may have asked, a frame inside the page is named rather than the page itself.
  const lowest = Math.min(...candidates.map(({ opener }) => trust(opener)));
  const peers = candidates.filter(({ opener }) => trust(opener) === lowest);
  const named = (peers.find(({ frame }) => frame.parent) ?? peers[0]).opener;
  return { ...decided, site: named.kind === "page" ? named.site : null };
}

// Where a page's window.open, target=_blank link or form may open a tab, or null when it may not.
export function windowOpenRoute(contents: WebContents, details: Pick<Electron.HandlerDetails, "url" | "referrer">): WindowOpenRoute | null {
  const opener = openingFrame(contents, details);
  return opener ? routeFrom(opener, details.url) : null;
}

// The frame a context menu was opened on, taken when the menu opens (Chrome's ContextMenuParams::frame_origin).
// The user picks the menu's items, so they count as the user's own action.
export function frameOpener(frame: WebFrameMain | null | undefined): Opener | null {
  try {
    return frame && !frame.isDestroyed() ? openerOf(frame, true) : null;
  } catch {
    return null;
  }
}

// Like Chrome's "Open link in new tab": the link opens as if the frame it's in had opened it.
export function linkOpenRoute(opener: Opener | null, url: string): WindowOpenRoute | null {
  return opener ? routeFrom(opener, url) : null;
}

// Like Chrome's external protocol dialog, which names the origin that asked (file:// for a local file); our own pages
// never hand URLs to other apps, and a request no origin can be named for is refused.
function externalRoute(opener: Opener, url: string): WindowOpenRoute | null {
  const requester = opener.kind === "local" ? "file://" : opener.kind === "page" ? opener.site : null;
  if (!requester) return null;
  const initiator = opener.kind === "page" ? opener.origin : null;
  const mayDownload = opener.kind === "local" ? localDocumentMayDownload(opener.document, url, opener.activated) : true;
  return { url, initiator, byBrowser: false, external: { requester }, mayDownload };
}

function routeFrom(opener: Opener, url: string): WindowOpenRoute | null {
  const target = canonicalUrl(url);
  if (!target) return null;
  if (!BROWSER_SCHEMES.has(target.scheme)) return externalRoute(opener, target.href);
  if (opener.kind === "internal") return { url, initiator: null, byBrowser: true, external: null, mayDownload: true };
  if (PAGE_BLOCKED_SCHEMES.has(target.scheme) || target.scheme === INTERNAL_SCHEME) return null;
  if (opener.kind === "local") {
    if (target.scheme === "chrome-extension" || !localDocumentMayOpen(opener.document, target.href, opener.activated)) return null;
    const mayDownload = localDocumentMayDownload(opener.document, target.href, opener.activated);
    return { url: target.href, initiator: null, byBrowser: false, external: null, mayDownload };
  }
  if (target.scheme === DOC_SCHEME) return null;
  if (!opener.origin && target.scheme === "chrome-extension") return null;
  return { url: target.href, initiator: opener.origin, byBrowser: false, external: null, mayDownload: true };
}
