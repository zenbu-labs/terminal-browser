import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { requestHooks } from "@zenbu-labs/pixel";
import { openBeneath } from "@zenbu-labs/pixel/native";
import { app } from "electron";
import type { OnBeforeSendHeadersListenerDetails, Session, WebContents, WebFrameMain } from "electron";

import { hasTransientUserActivation, recentInputActivation } from "../extensions/user-activation";
import { DOC_SCHEME } from "../url";
import { INTERNAL_SCHEME } from "./internal";

const GRANT_HEADER = "x-terminal-browser-file-grant";

export const isLocalDocument = (url: string) => url.startsWith(`${DOC_SCHEME}://`);
export const withoutFragment = (url: string) => url.split("#")[0];

export function localPath(url: string): string {
  return path.resolve(decodeURIComponent(new URL(url).pathname));
}

// srcdoc and blank frames run with the origin of the document that made them.
export function documentOf(frame: WebFrameMain | null | undefined): string {
  let current = frame;
  try {
    while (current?.parent && /^about:(?:srcdoc|blank)/.test(current.url)) current = current.parent;
    return current?.url ?? "";
  } catch {
    return "";
  }
}

function showsLocalDocument(contents: WebContents): boolean {
  try {
    return contents.mainFrame.framesInSubtree.some((frame) => isLocalDocument(frame.url));
  } catch {
    return false;
  }
}

function contains(folder: string, file: string): boolean {
  const relative = path.relative(folder, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function inFolderOf(document: string, url: string): boolean {
  try {
    return contains(path.dirname(localPath(document)), localPath(url));
  } catch {
    return false;
  }
}

export function activated(frame: WebFrameMain | null | undefined): boolean {
  try {
    return !!frame && (hasTransientUserActivation(frame) || recentInputActivation(frame));
  } catch {
    return false;
  }
}

// A local document opens other local documents in its own folder, and ones elsewhere only when the user clicked
// or typed in it; it never starts a download unless the user did, and never one of a file from another folder.
export function localDocumentMayOpen(document: string, url: string, userActivated: boolean): boolean {
  return !isLocalDocument(url) || userActivated || inFolderOf(document, url);
}

export function localDocumentMayDownload(document: string, url: string, userActivated: boolean): boolean {
  return userActivated && (!isLocalDocument(url) || inFolderOf(document, url));
}

// `page` is the local page whose folder the file must come from, if any.
export interface LocalFileGrant {
  url: string;
  page: string | null;
}

export class RefusedFileError extends Error {}

const { O_DIRECTORY, O_NONBLOCK, O_RDONLY } = fs.constants;
const REMEMBERED_FOLDERS = 1024;

function folderIdentity(fd: number): string {
  const stat = fs.fstatSync(fd, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
}

function openRegularFile(file: string): number {
  const fd = fs.openSync(file, O_RDONLY | O_NONBLOCK);
  if (fs.fstatSync(fd).isFile()) return fd;
  fs.closeSync(fd);
  throw Object.assign(new Error(file), { code: "EINVAL" });
}

function openPage(folder: number, file: string): number {
  try {
    return openBeneath(folder, path.basename(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") return openRegularFile(file);
    throw error;
  }
}

function grantFor(details: OnBeforeSendHeadersListenerDetails): LocalFileGrant | null {
  const document = documentOf(details.frame);
  const url = withoutFragment(details.url);
  if (document.startsWith(`${INTERNAL_SCHEME}://`)) return { url, page: null };
  if (!isLocalDocument(document)) return null;
  const navigation = details.resourceType === "mainFrame" || details.resourceType === "subFrame";
  if (!navigation) return { url, page: localPath(document) };
  return localDocumentMayOpen(document, url, activated(details.frame)) ? { url, page: null } : null;
}

// Local documents are sandboxed, so their requests carry the same opaque
// origin as a sandboxed or data: frame on any website. While one is open, each
// such request is checked against the frame that sent it and given a one-time
// grant in a header that only the file handler reads; checking slows every
// request in the session, so it is off the rest of the time.
export class LocalFileAccess {
  private readonly grants = new Map<string, LocalFileGrant>();
  private readonly servedFrom = new Map<string, string>();
  private readonly showing = new Set<WebContents>();
  private removeHook: (() => void) | null = null;

  constructor(private readonly session: Session) {}

  redeem(request: Request): LocalFileGrant | null {
    const token = request.headers.get(GRANT_HEADER);
    const grant = token ? this.grants.get(token) : undefined;
    if (!token || !grant) return null;
    this.grants.delete(token);
    const initiator = (request as { initiatorOrigin?: string }).initiatorOrigin;
    return initiator === "null" && withoutFragment(request.url) === grant.url ? grant : null;
  }

  // The files a local page loads into itself must come from the folder it was
  // served from, so scripts it runs can't read the rest of the disk. Each file is
  // opened once, without following symlinks, and served from that descriptor. A hard
  // link is only served from a folder that nobody but the file's owner can write to.
  open(file: string, grant: LocalFileGrant | null): number {
    const page = grant?.page ?? null;
    const folder = path.dirname(page ?? file);
    if (page && !contains(folder, file)) throw new RefusedFileError(file);
    const dir = fs.openSync(folder, O_RDONLY | O_DIRECTORY);
    try {
      const identity = folderIdentity(dir);
      if (!page) {
        const fd = openPage(dir, file);
        this.servedFrom.delete(file);
        this.servedFrom.set(file, identity);
        if (this.servedFrom.size > REMEMBERED_FOLDERS) this.servedFrom.delete(this.servedFrom.keys().next().value as string);
        return fd;
      }
      if (this.servedFrom.get(page) !== identity) throw new RefusedFileError(file);
      try {
        return openBeneath(dir, path.relative(folder, file).split(path.sep).join("/"), true);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
        throw new RefusedFileError(file);
      }
    } finally {
      fs.closeSync(dir);
    }
  }

  opening(contents: WebContents) {
    if (this.showing.has(contents)) return;
    this.showing.add(contents);
    this.removeHook ??= requestHooks(this.session).beforeSendHeaders((details, headers) => this.vet(details, headers));
  }

  settled(contents: WebContents) {
    if (!this.showing.has(contents) || (!contents.isDestroyed() && showsLocalDocument(contents))) return;
    this.showing.delete(contents);
    if (this.showing.size > 0) return;
    this.removeHook?.();
    this.removeHook = null;
    this.grants.clear();
  }

  private vet(details: OnBeforeSendHeadersListenerDetails, headers: Record<string, string>): "cancel" | void {
    if (!isLocalDocument(details.url)) return;
    for (const name of Object.keys(headers)) if (name.toLowerCase() === GRANT_HEADER) delete headers[name];
    if (details.initiatorOrigin !== "null") return;
    const grant = grantFor(details);
    if (!grant) return "cancel";
    const token = randomUUID();
    this.grants.set(token, grant);
    headers[GRANT_HEADER] = token;
  }
}

export function watchLocalDocuments(accessFor: (session: Session) => LocalFileAccess | undefined) {
  app.on("web-contents-created", (_event, contents) => {
    const session = contents.session;
    const access = () => accessFor(session);
    contents.on("did-start-navigation", (details) => {
      if (isLocalDocument(details.url)) access()?.opening(contents);
    });
    contents.on("did-stop-loading", () => access()?.settled(contents));
    contents.once("destroyed", () => access()?.settled(contents));
  });
}
