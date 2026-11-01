import type { WebContents, WebFrameMain } from "electron";

import { canonicalOrigin, canonicalUrl } from "../canonical-url";
import { DOC_SCHEME } from "../url";
import { INTERNAL_SCHEME } from "./internal";

// The tab we open for a page loads the URL itself instead of the page navigating, so the checks Chromium makes
// on a page's navigations are made here: a page may not open local files, our pages, or URLs it couldn't load.
const PAGE_BLOCKED_SCHEMES = new Set(["javascript", "data", "filesystem", "file", "view-source", "chrome", "chrome-untrusted", "devtools"]);
// Any other scheme belongs to another app: like Chrome, it opens no tab, and the user is asked before it's handed over.
const BROWSER_SCHEMES = new Set([...PAGE_BLOCKED_SCHEMES, "http", "https", "about", "blob", "chrome-extension", "ws", "wss", DOC_SCHEME, INTERNAL_SCHEME]);

export type Opener =
  | { kind: "internal" }
  | { kind: "local" }
  | { kind: "page"; origin: string | null };

export interface WindowOpenRoute {
  url: string;
  // the origin the new tab's load runs as, or null for a load the browser makes
  initiator: string | null;
  byBrowser: boolean;
  external: boolean;
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

function openerOf(frame: WebFrameMain): Opener {
  const origin = frame.origin === "null" ? null : canonicalOrigin(frame.origin);
  if (origin?.startsWith(`${INTERNAL_SCHEME}://`)) return { kind: "internal" };
  if (origin?.startsWith(`${DOC_SCHEME}://`) || (!origin && documentUrl(frame).startsWith(`${DOC_SCHEME}://`))) return { kind: "local" };
  return { kind: "page", origin };
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
  const candidates = openingFrames(contents, details).map(openerOf);
  if (candidates.length === 0) return null;
  return candidates.reduce((least, opener) => {
    if (trust(opener) !== trust(least)) return trust(opener) < trust(least) ? opener : least;
    return least.kind === "page" && opener.kind === "page" && least.origin !== opener.origin ? { kind: "page", origin: null } : least;
  });
}

// Where a page's window.open, target=_blank link or form may open a tab, or null when it may not.
export function windowOpenRoute(contents: WebContents, details: Pick<Electron.HandlerDetails, "url" | "referrer">): WindowOpenRoute | null {
  const opener = openingFrame(contents, details);
  return opener ? routeFrom(opener, details.url) : null;
}

// The frame a context menu was opened on, taken when the menu opens (Chrome's ContextMenuParams::frame_origin).
export function frameOpener(frame: WebFrameMain | null | undefined): Opener | null {
  try {
    return frame && !frame.isDestroyed() ? openerOf(frame) : null;
  } catch {
    return null;
  }
}

// Like Chrome's "Open link in new tab": the link opens as if the frame it's in had opened it.
export function linkOpenRoute(opener: Opener | null, url: string): WindowOpenRoute | null {
  return opener ? routeFrom(opener, url) : null;
}

function routeFrom(opener: Opener, url: string): WindowOpenRoute | null {
  const target = canonicalUrl(url);
  if (!target) return null;
  const external = !BROWSER_SCHEMES.has(target.scheme);
  if (opener.kind === "internal") return { url, initiator: null, byBrowser: true, external };
  if (PAGE_BLOCKED_SCHEMES.has(target.scheme) || target.scheme === INTERNAL_SCHEME) return null;
  if (opener.kind === "local") {
    if (target.scheme === "chrome-extension") return null;
    return { url: target.href, initiator: null, byBrowser: false, external };
  }
  if (target.scheme === DOC_SCHEME) return null;
  if (!opener.origin && target.scheme === "chrome-extension") return null;
  return { url: target.href, initiator: opener.origin, byBrowser: false, external };
}
