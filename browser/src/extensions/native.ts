import type { ClearDataOptions, Session, WebContents, WebFrameMain } from "electron";

export interface NativePermissions {
  permissions: string[];
  origins: string[];
}

// Added to Session.extensions by pixel's Electron patches; they update the permissions Chromium itself
// checks in scripting, tabs.sendMessage, webRequest, declarativeNetRequest and userScripts.
interface PatchedExtensions {
  grantActiveTab(extensionId: string, contents: WebContents): boolean;
  revokeActiveTab(extensionId: string, contents: WebContents): void;
  setRuntimePermissions(extensionId: string, granted: NativePermissions): Promise<void>;
  getActivePermissions(extensionId: string): NativePermissions | null;
  setUserScriptsAllowed(extensionId: string, allowed: boolean): boolean;
  setViewType(contents: WebContents, viewType: NativeViewType): boolean;
}

// Popups and side panels aren't tabs: Chromium gives their requests tabId -1 and their messages no sender.tab.
export type NativeViewType = "tab" | "popup" | "sidePanel";

function patched(session: Session): PatchedExtensions {
  return session.extensions as unknown as PatchedExtensions;
}

export function grantNativeActiveTab(session: Session, extensionId: string, contents: WebContents): boolean {
  if (contents.isDestroyed()) return false;
  return patched(session).grantActiveTab(extensionId, contents);
}

export function revokeNativeActiveTab(session: Session, extensionId: string, contents: WebContents) {
  if (contents.isDestroyed()) return;
  patched(session).revokeActiveTab(extensionId, contents);
}

export async function setNativeRuntimePermissions(session: Session, extensionId: string, granted: NativePermissions) {
  await patched(session).setRuntimePermissions(extensionId, granted);
}

export function nativeActivePermissions(session: Session, extensionId: string): NativePermissions | null {
  return patched(session).getActivePermissions(extensionId);
}

export function setNativeUserScriptsAllowed(session: Session, extensionId: string, allowed: boolean): boolean {
  return patched(session).setUserScriptsAllowed(extensionId, allowed);
}

export function setNativeViewType(session: Session, contents: WebContents, viewType: NativeViewType): boolean {
  if (contents.isDestroyed()) return false;
  return patched(session).setViewType(contents, viewType);
}

// pixel's Electron patches add `since` (ms since the epoch) to clearData, where older data is kept, and the
// data types "httpCache" (the cache without Cache Storage) and "cacheStorage".
export type NativeClearDataType = NonNullable<ClearDataOptions["dataTypes"]>[number] | "httpCache" | "cacheStorage";

export function clearSessionData(
  session: Session,
  options: Omit<ClearDataOptions, "dataTypes"> & { dataTypes?: NativeClearDataType[] },
  since: number,
): Promise<void> {
  return session.clearData({ ...options, ...(since > 0 ? { since } : {}) } as ClearDataOptions);
}

// Partitioned (CHIPS) cookies, added to Session.cookies by pixel's Electron patches. A partitionKey of null
// means unpartitioned cookies only, one without topLevelSite every partition.
export interface NativePartitionKey {
  topLevelSite?: string;
  hasCrossSiteAncestor?: boolean;
}

type PatchedCookies = Omit<Electron.Cookies, "get" | "set" | "remove"> & {
  get(filter: Electron.CookiesGetFilter & { partitionKey?: NativePartitionKey | null }): Promise<Electron.Cookie[]>;
  set(details: Electron.CookiesSetDetails & { partitionKey?: NativePartitionKey }): Promise<void>;
  remove(url: string, name: string, partitionKey?: NativePartitionKey | null): Promise<void>;
};

export function nativeCookies(session: Session): PatchedCookies {
  return session.cookies as unknown as PatchedCookies;
}

// What chrome.debugger.getTargets lists, from Chromium's DevTools agent hosts (pixel's Electron patches).
export interface NativeDebuggerTarget {
  id: string;
  type: "page" | "worker" | "other";
  title: string;
  url: string;
  attached: boolean;
  tabId?: number;
  extensionId?: string;
  faviconUrl?: string;
}

export function nativeDebuggerTargets(session: Session): NativeDebuggerTarget[] {
  return (session.extensions as unknown as { getDebuggerTargets(): NativeDebuggerTarget[] }).getDebuggerTargets();
}

// pixel's Electron patches: load a URL as if a page of `initiatorOrigin` started the navigation (Chrome does this
// for tabs.create/update), so the initiator's navigation rules apply and the page gets no user activation.
export function loadURLFromOrigin(contents: WebContents, url: string, initiatorOrigin: string): Promise<void> {
  return contents.loadURL(url, { initiatorOrigin } as Electron.LoadURLOptions);
}

// pixel's Electron patches: with persist false, a per-tab or manual zoom mode resets on navigation like Chrome's.
export function setNativeZoomMode(contents: WebContents, mode: "default" | "isolated" | "manual" | "disabled", persist: boolean) {
  (contents as unknown as { setZoomMode(mode: string, options: { persist: boolean }): void }).setZoomMode(mode, { persist });
}

// Added to WebFrameMain by pixel's Electron patches: the id Chromium gives the frame's current document,
// which extensions see as sender.documentId and pass to tabs.sendMessage, scripting and webNavigation.
interface PatchedFrame {
  documentId: string;
  documentLifecycle: "prerender" | "active" | "cached" | "pending_deletion";
}

export function frameDocumentId(frame: WebFrameMain): string {
  return (frame as unknown as PatchedFrame).documentId;
}

export function frameDocumentLifecycle(frame: WebFrameMain): PatchedFrame["documentLifecycle"] {
  return (frame as unknown as PatchedFrame).documentLifecycle;
}
