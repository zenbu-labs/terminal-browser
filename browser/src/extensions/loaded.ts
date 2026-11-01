import type { Session } from "electron";
import type { ExtensionRecord } from "shared";

import { PatternSet, manifestAction, optionalPermissions, requiredPermissions } from "./manifest";
import type { Manifest } from "./manifest";
import { setNativeRuntimePermissions } from "./native";

const USER_GESTURE_MS = 5_000;

export class LoadedExtension {
  readonly id: string;
  readonly path: string;
  readonly manifest: Manifest;
  record: ExtensionRecord;
  private apiPermissions = new Set<string>();
  private hostPermissions = new PatternSet([]);
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

  get baseUrl(): string {
    return `chrome-extension://${this.id}/`;
  }

  url(relative: string): string {
    return new URL(relative.replace(/^\//, ""), this.baseUrl).href;
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
    this.hostPermissions = new PatternSet([...required.hosts, ...this.record.grantedOrigins]);
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

  hasHostAccess(url: string): boolean {
    if (url.startsWith(this.baseUrl)) return true;
    return this.hostPermissions.matches(url);
  }

  grantActiveTab(tabId: number, url: string) {
    try {
      this.activeTabs.set(tabId, new URL(url).origin);
    } catch {}
  }

  revokeActiveTab(tabId: number) {
    this.activeTabs.delete(tabId);
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
