import path from "node:path";
import { fileURLToPath } from "node:url";

import { requestHooks } from "@zenbu-labs/pixel";
import type { Session, WebContents, WebFrameMain } from "electron";

import { DOC_SCHEME, documentUrlForFile } from "../url";
import { INTERNAL_SCHEME } from "./internal";
import { localPath } from "./local-files";

const LOCAL_SCHEMES = new Set([INTERNAL_SCHEME, DOC_SCHEME]);
const REFUSAL_MS = 10_000;

function schemeOf(url: string): string {
  return /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1].toLowerCase() ?? "";
}

function sameFile(fileUrl: string, documentUrl: string): boolean {
  try {
    return path.resolve(fileURLToPath(fileUrl.split(/[?#]/)[0])) === localPath(documentUrl);
  } catch {
    return false;
  }
}

// Chromium refuses redirects into file: and chrome: pages; ours get the same rule. The one redirect into a
// local document allowed is the one that shows a file:// url as the sandboxed document for that file.
export function redirectAllowed(from: string, to: string): boolean {
  const target = schemeOf(to);
  if (!LOCAL_SCHEMES.has(target) || schemeOf(from) === target) return true;
  return target === DOC_SCHEME && schemeOf(from) === "file" && sameFile(from, to);
}

const refusals = new WeakMap<Session, Map<string, number>>();

// A file:// document could read every other local file, so no frame shows one: a page load of a file:// url
// becomes the sandboxed local document for that file, and nothing local pages load may come from file://.
// Redirects into our pages are refused here for every request, and for navigations by `refuseLocalRedirects`.
export function guardLocalLoads(session: Session) {
  const hooks = requestHooks(session);
  hooks.beforeRequest({ urls: ["file://*", "file://*/*"] }, (details) => {
    if (details.resourceType === "mainFrame") {
      const document = documentUrlForFile(details.url);
      return document ? { redirectURL: document } : { cancel: true };
    }
    const initiator = details.initiatorOrigin;
    if (initiator === "null" || schemeOf(initiator ?? "") === "file") return { cancel: true };
  });

  const refused = new Map<string, number>();
  refusals.set(session, refused);
  hooks.beforeRedirect((details) => {
    if (redirectAllowed(details.url, details.redirectURL)) return;
    const now = Date.now();
    for (const [url, until] of refused) if (until < now) refused.delete(url);
    refused.set(details.redirectURL, now + REFUSAL_MS);
  });
  hooks.beforeRequest({ urls: [`${INTERNAL_SCHEME}://*/*`, `${DOC_SCHEME}://*/*`] }, (details) => {
    const until = refused.get(details.url);
    if (until === undefined) return;
    refused.delete(details.url);
    if (until >= Date.now()) return { cancel: true };
  });
}

function frameKey(frame: WebFrameMain | null | undefined): number | null {
  try {
    return frame?.frameTreeNodeId ?? null;
  } catch {
    return null;
  }
}

export function refuseLocalRedirects(contents: WebContents) {
  const navigating = new Map<number, string>();
  contents.on("did-start-navigation", (details) => {
    const frame = frameKey(details.frame);
    if (frame !== null) navigating.set(frame, details.url);
  });
  contents.on("will-redirect", (event) => {
    const frame = frameKey(event.frame);
    const from = frame === null ? "" : (navigating.get(frame) ?? "");
    if (redirectAllowed(from, event.url)) {
      if (frame !== null) navigating.set(frame, event.url);
      return;
    }
    event.preventDefault();
    refusals.get(contents.session)?.delete(event.url);
  });
  contents.once("destroyed", () => navigating.clear());
}
