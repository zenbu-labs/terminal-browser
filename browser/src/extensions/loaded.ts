import type { Session } from "electron";
import type { ExtensionRecord } from "shared";

import { PatternSet, hostPermissionPattern, manifestAction, optionalPermissions, patternMatches, requiredPermissions } from "./manifest";
import type { Manifest, MatchPattern } from "./manifest";
import { setNativeRuntimePermissions } from "./native";

const USER_GESTURE_MS = 5_000;

// Chrome lets extensions the user loaded unpacked read file:// URLs from the start.
export function allowsFileAccess(record: ExtensionRecord): boolean {
  return record.source === "unpacked";
}

const PAGE_SCHEMES = new Set(["http:", "https:", "file:", "ftp:", "ws:", "wss:", "chrome:", "chrome-extension:", "filesystem:", "data:", "uuid-in-package:"]);
const WEBSTORE_HOSTS = ["chrome.google.com", "chromewebstore.google.com"];

export const CANNOT_ACCESS_PAGE = "Cannot access contents of the page. Extension manifest must request permission to access the respective host.";

function cannotAccess(url: string, hasTabs: boolean): string {
  return hasTabs ? `Cannot access contents of url "${url}". Extension manifest must request permission to access this host.` : CANNOT_ACCESS_PAGE;
}

// Chromium's PermissionsData::IsRestrictedUrl: no host permission reaches these.
// Returns Chrome's error for the page, or null when it isn't restricted.
export function restrictedUrlError(url: string, extensionId: string, hasTabs: boolean): string | null {
  if (url === "about:blank" || url === "about:srcdoc") return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return cannotAccess(url, hasTabs);
  }
  if (!PAGE_SCHEMES.has(parsed.protocol)) return cannotAccess(url, hasTabs);
  if (WEBSTORE_HOSTS.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) {
    return "The extensions gallery cannot be scripted.";
  }
  if (parsed.protocol === "chrome:") return "Cannot access a chrome:// URL";
  if (parsed.protocol === "chrome-extension:" && parsed.host !== extensionId) return "Cannot access a chrome-extension:// URL of different extension";
  return null;
}

export class LoadedExtension {
  readonly id: string;
  readonly path: string;
  readonly manifest: Manifest;
  record: ExtensionRecord;
  private apiPermissions = new Set<string>();
  private hostPermissions = new PatternSet([]);
  private hostAccess: MatchPattern[] = [];
  private readonly activeTabs = new Map<number, string>();
  private lastUserGesture = 0;

  constructor(
    record: ExtensionRecord,
    manifest: Manifest,
    private readonly session: Session,
  ) {
    this.id = record.id;
    this.path = record.path;
    this.manifest = manifest;
    this.record = record;
    this.computePermissions();
  }

  get name(): string {
    return this.manifest.name;
  }

  get allowsFileAccess(): boolean {
    return allowsFileAccess(this.record);
  }

  get baseUrl(): string {
    return `chrome-extension://${this.id}/`;
  }

  // Chrome's Extension::ResolveExtensionURL: a path that resolves outside this
  // extension (another site, scheme or extension) gives nothing.
  url(relative: string): string | null {
    let resolved: URL;
    try {
      resolved = new URL(relative, this.baseUrl);
    } catch {
      return null;
    }
    return resolved.protocol === "chrome-extension:" && resolved.host === this.id ? resolved.href : null;
  }

  hasAction(): boolean {
    return manifestAction(this.manifest) !== null || this.manifest.manifest_version >= 3;
  }

  async refreshPermissions() {
    const grantedApis = this.computePermissions();
    await setNativeRuntimePermissions(this.session, this.id, {
      permissions: grantedApis,
      origins: this.record.grantedOrigins,
    });
  }

  private computePermissions(): string[] {
    const required = requiredPermissions(this.manifest);
    const granted = new Set(this.record.grantedPermissions);
    const grantedApis = optionalPermissions(this.manifest).api.filter((p) => granted.has(p));
    this.apiPermissions = new Set([...required.api, ...grantedApis]);
    const hosts = [...required.hosts, ...this.record.grantedOrigins];
    this.hostPermissions = new PatternSet(hosts);
    this.hostAccess = hosts.map(hostPermissionPattern).filter((pattern): pattern is MatchPattern => pattern !== null);
    return grantedApis;
  }

  hasApiPermission(permission: string): boolean {
    return this.apiPermissions.has(permission);
  }

  get apis(): string[] {
    return [...this.apiPermissions];
  }

  get hosts(): string[] {
    return this.hostPermissions.sources;
  }

  get hasAllUrls(): boolean {
    return this.hostAccess.some((pattern) => pattern.all);
  }

  // Chromium's PermissionsData::HasHostPermission: file:// only counts once
  // the user allowed file access.
  hasHostAccess(url: string): boolean {
    if (url.startsWith(this.baseUrl)) return true;
    if (url.startsWith("file:") && !this.allowsFileAccess) return false;
    return this.hostAccess.some((pattern) => patternMatches(pattern, url));
  }

  // Chromium's PermissionsData::GetPageAccess: pages no extension may touch,
  // then the extension's hosts or its activeTab grant. Returns Chrome's error,
  // or null when the extension may access the page.
  pageAccessError(url: string, tabId: number | null): string | null {
    const hasTabs = this.hasApiPermission("tabs");
    const restricted = restrictedUrlError(url, this.id, hasTabs);
    if (restricted) return restricted;
    const fileBlocked = url.startsWith("file:") && !this.allowsFileAccess;
    if (tabId !== null && !fileBlocked && this.hasActiveTab(tabId, url)) return null;
    if (!url.startsWith(this.baseUrl) && this.hasHostAccess(url)) return null;
    return cannotAccess(url, hasTabs);
  }

  grantActiveTab(tabId: number, url: string) {
    try {
      this.activeTabs.set(tabId, new URL(url).origin);
    } catch {}
  }

  revokeActiveTab(tabId: number) {
    this.activeTabs.delete(tabId);
  }

  hasActiveTabGrant(tabId: number): boolean {
    return this.activeTabs.has(tabId);
  }

  hasActiveTab(tabId: number, url: string): boolean {
    const origin = this.activeTabs.get(tabId);
    if (!origin) return false;
    try {
      return new URL(url).origin === origin;
    } catch {
      return false;
    }
  }

  noteUserGesture() {
    this.lastUserGesture = Date.now();
  }

  // Chrome only lets some calls happen during a click; a service worker has no
  // click of its own, so it counts if the user acted on this extension just now.
  hadRecentUserGesture(withinMs = USER_GESTURE_MS): boolean {
    return Date.now() - this.lastUserGesture <= withinMs;
  }

  canSeeTab(tabId: number, url: string): boolean {
    return this.hasApiPermission("tabs") || this.hasHostAccess(url) || this.hasActiveTab(tabId, url);
  }
}
