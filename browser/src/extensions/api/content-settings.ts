import { requestHooks } from "@zenbu-labs/pixel";
import { app, webContents as allWebContents } from "electron";
import type { OnHeadersReceivedListenerDetails, Session, WebContents } from "electron";

import { CONTENT_TYPES, WILDCARD, isWildcard, parsePattern, samePattern } from "../content-settings";
import type { ContentSettingsStore, Pattern, Setting } from "../content-settings";
import { openingFrames } from "../../pages/window-open";
import { takePopupActivation } from "../user-activation";
import type { ExtensionService } from "../service";

const INCOGNITO_ERROR = "You do not have permission to access incognito preferences.";
const INVALID = "Invalid invocation";

// Settings terminal-browser can't fully enforce, so set() refuses them instead of pretending:
// cookies can't be kept from document.cookie and site storage, location is never granted,
// and there is no prompt for multiple downloads.
const UNSUPPORTED: Record<string, { name: string; settings: Setting[] }> = {
  cookies: { name: "cookies", settings: ["block", "session_only"] },
  geolocation: { name: "location", settings: ["allow", "ask"] },
  "automatic-downloads": { name: "automaticDownloads", settings: ["ask"] },
};

function detailsOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(INVALID);
  return value as Record<string, unknown>;
}

function typeOf(value: unknown): string {
  if (typeof value !== "string" || !Object.hasOwn(CONTENT_TYPES, value)) throw new Error(INVALID);
  return value;
}

function checkedUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error(INVALID);
  try {
    return new URL(value).href;
  } catch {
    throw new Error(`The URL "${value}" is invalid.`);
  }
}

function checkedPattern(value: unknown): Pattern {
  if (typeof value !== "string") throw new Error(INVALID);
  const parsed = parsePattern(value);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.pattern;
}

function checkedScope(value: unknown): "regular" | "incognito_session_only" {
  if (value === undefined || value === "regular") return "regular";
  if (value === "incognito_session_only") return value;
  throw new Error(INVALID);
}

export function getSetting(store: ContentSettingsStore, type: unknown, raw: unknown): { setting: Setting } {
  const name = typeOf(type);
  const details = detailsOf(raw);
  const primary = checkedUrl(details.primaryUrl);
  const secondary = details.secondaryUrl === undefined ? primary : checkedUrl(details.secondaryUrl);
  if (details.incognito === true) throw new Error(INCOGNITO_ERROR);
  return { setting: store.effective(name, primary, secondary) };
}

export function setSetting(store: ContentSettingsStore, extensionId: string, type: unknown, raw: unknown) {
  const name = typeOf(type);
  const info = CONTENT_TYPES[name];
  const details = detailsOf(raw);
  const primary = checkedPattern(details.primaryPattern);
  const secondary = details.secondaryPattern === undefined ? WILDCARD : checkedPattern(details.secondaryPattern);
  const setting = details.setting as Setting;
  if (!info.valid.includes(setting)) throw new Error(INVALID);
  const scope = checkedScope(details.scope);
  const everywhere = isWildcard(primary) && isWildcard(secondary);
  if (name === "anti-abuse" && !everywhere) {
    throw new Error("Site-specific settings are not allowed for this type. The URL pattern must be '<all_urls>'.");
  }
  if (everywhere && setting === "allow" && (name === "media-stream-camera" || name === "media-stream-mic")) {
    throw new Error(`'allow' is not supported as the default setting of ${name === "media-stream-camera" ? "camera" : "microphone"}.`);
  }
  if (!samePattern(primary, secondary) && !isWildcard(secondary) && !info.embeddedPatterns) {
    throw new Error("Embedded patterns are not supported for this setting.");
  }
  if (scope === "incognito_session_only") throw new Error(INCOGNITO_ERROR);
  const unsupported = UNSUPPORTED[name];
  if (unsupported?.settings.includes(setting)) {
    // fixme: placeholder copy
    throw new Error(`'${setting}' is not supported for ${unsupported.name} in terminal-browser.`);
  }
  store.set(extensionId, name, primary, secondary, setting);
}

export function clearSettings(store: ContentSettingsStore, extensionId: string, type: unknown, raw: unknown) {
  const name = typeOf(type);
  if (checkedScope(detailsOf(raw).scope) === "incognito_session_only") return;
  store.clear(extensionId, name);
}

// Chrome keys javascript and images rules on the tab's top-level page; a policy header on
// that page's documents (its frames too) stops their scripts or images.
export function documentPolicy(store: ContentSettingsStore, topUrl: string, documentUrl: string): string | null {
  const directives: string[] = [];
  if (store.ruleForPage("javascript", topUrl, documentUrl) === "block") directives.push("script-src 'none'");
  if (store.ruleForPage("images", topUrl, documentUrl) === "block") directives.push("img-src 'none'");
  return directives.length > 0 ? directives.join("; ") : null;
}

export function blockingPolicy(store: ContentSettingsStore, details: OnHeadersReceivedListenerDetails): string | null {
  if (details.resourceType !== "mainFrame" && details.resourceType !== "subFrame") return null;
  const top = details.resourceType === "mainFrame" ? details.url : (details.frame?.top?.url ?? details.webContents?.getURL() ?? "");
  return top ? documentPolicy(store, top, details.url) : null;
}

const withoutHash = (url: string) => url.split("#")[0];

// A document a service worker or the back/forward cache handed over never got the policy
// header, so its page is reloaded once past both, after the blocked sites' workers are gone.
export class DocumentGuard {
  private readonly policed = new Set<string>();
  private readonly retried = new WeakMap<WebContents, string>();
  private readonly watched = new WeakSet<WebContents>();

  constructor(
    private readonly store: ContentSettingsStore,
    private readonly session: Session,
    private readonly sweeper: ServiceWorkerSweeper,
  ) {}

  policedResponse(contentsId: number, url: string) {
    this.policed.add(`${contentsId} ${withoutHash(url)}`);
    if (this.policed.size > 500) this.policed.delete(this.policed.values().next().value as string);
  }

  watch(contents: WebContents) {
    if (this.watched.has(contents)) return;
    this.watched.add(contents);
    contents.on("did-frame-navigate", (_event, url, _code, _status, isMainFrame) => this.committed(contents, url, isMainFrame));
  }

  committed(contents: WebContents, url: string, isMainFrame: boolean) {
    if (contents.session !== this.session || !/^(https?|file):/i.test(url)) return;
    const top = isMainFrame ? url : contents.getURL();
    if (!documentPolicy(this.store, top, url)) return;
    if (this.policed.delete(`${contents.id} ${withoutHash(url)}`)) {
      this.retried.delete(contents);
      return;
    }
    if (this.retried.get(contents) === top) return;
    this.retried.set(contents, top);
    void this.sweeper.sweep().then(() => {
      if (!contents.isDestroyed()) contents.reloadIgnoringCache();
    });
  }
}

// A service worker could hand a blocked page a document without the policy header, so the
// workers of blocked sites are unregistered, through the DevTools protocol of an open tab.
export class ServiceWorkerSweeper {
  private running: Promise<void> | null = null;
  private queued: Promise<void> | null = null;

  constructor(
    private readonly store: ContentSettingsStore,
    private readonly session: Session,
  ) {}

  sweep(): Promise<void> {
    if (this.running) {
      this.queued ??= this.running.then(() => {
        this.queued = null;
        return this.sweep();
      });
      return this.queued;
    }
    this.running = this.run()
      .catch(() => {})
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async run() {
    if (!this.store.hasRules("javascript") && !this.store.hasRules("images")) return;
    const contents = allWebContents
      .getAllWebContents()
      .find((candidate) => !candidate.isDestroyed() && candidate.session === this.session && candidate.debugger.isAttached());
    if (!contents) return;
    let listed: (scopes: string[]) => void = () => {};
    const scopes = new Promise<string[]>((resolve) => {
      listed = resolve;
      setTimeout(() => resolve([]), 1000);
    });
    const onMessage = (_event: unknown, method: string, params: { registrations?: { scopeURL: string; isDeleted: boolean }[] }) => {
      if (method === "ServiceWorker.workerRegistrationUpdated") {
        listed((params.registrations ?? []).filter((entry) => !entry.isDeleted).map((entry) => entry.scopeURL));
      }
    };
    contents.debugger.on("message", onMessage);
    try {
      await contents.debugger.sendCommand("ServiceWorker.enable");
      for (const scopeURL of await scopes) {
        if (documentPolicy(this.store, scopeURL, scopeURL)) await contents.debugger.sendCommand("ServiceWorker.unregister", { scopeURL });
      }
    } finally {
      contents.debugger.off("message", onMessage);
      if (!contents.isDestroyed()) await contents.debugger.sendCommand("ServiceWorker.disable").catch(() => {});
    }
  }
}

// Like Chrome's popup blocker: a "block" rule for the tab's page stops windows it opens without a click.
export function popupBlocked(service: ExtensionService, contents: WebContents, details: Pick<Electron.HandlerDetails, "referrer">): boolean {
  if (contents.session !== service.session) return false;
  if (service.contentSettings.ruleForPage("popups", contents.getURL()) !== "block") return false;
  return !takePopupActivation(contents, openingFrames(contents, details));
}

// Like Chrome's download limiter: with a "block" rule a page gets one download, and another
// only after the user loads a page in the tab themselves.
class DownloadLimiter {
  private readonly started = new WeakMap<WebContents, number>();
  private readonly watched = new WeakSet<WebContents>();

  constructor(private readonly store: ContentSettingsStore) {}

  watch(contents: WebContents) {
    if (this.watched.has(contents)) return;
    this.watched.add(contents);
    contents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument && !details.initiator) this.started.delete(contents);
    });
  }

  allows(contents: WebContents): boolean {
    const count = this.started.get(contents) ?? 0;
    this.started.set(contents, count + 1);
    return count === 0 || this.store.ruleForPage("automatic-downloads", contents.getURL()) !== "block";
  }
}

export function installContentSettings(service: ExtensionService) {
  const { router, contentSettings: store, session } = service;
  const options = { permission: "contentSettings" };
  router.handle("contentSettings.get", (_caller, type, details) => getSetting(store, type, details), options);
  router.handle("contentSettings.set", (caller, type, details) => setSetting(store, caller.extension.id, type, details), options);
  router.handle("contentSettings.clear", (caller, type, details) => clearSettings(store, caller.extension.id, type, details), options);
  router.handle("contentSettings.getResourceIdentifiers", () => undefined, options);

  const sweeper = new ServiceWorkerSweeper(store, session);
  const guard = new DocumentGuard(store, session, sweeper);
  let sweptRules = "";
  store.onChange(() => {
    const rules = store.rulesKey(["javascript", "images"]);
    if (rules === sweptRules) return;
    sweptRules = rules;
    void sweeper.sweep();
  });
  session.serviceWorkers.on("registration-completed", () => void sweeper.sweep());
  let removeHook: (() => void) | null = null;
  const syncHook = () => {
    const wanted = store.hasRules("javascript") || store.hasRules("images");
    if (wanted && !removeHook) {
      removeHook = requestHooks(session).headersReceived((details, headers) => {
        const policy = blockingPolicy(store, details);
        if (!policy) return;
        if (details.webContentsId !== undefined) guard.policedResponse(details.webContentsId, details.url);
        const name = Object.keys(headers).find((key) => key.toLowerCase() === "content-security-policy") ?? "Content-Security-Policy";
        headers[name] = [...(headers[name] ?? []), policy];
      });
    } else if (!wanted && removeHook) {
      removeHook();
      removeHook = null;
    }
  };
  store.onChange(syncHook);
  syncHook();

  const limiter = new DownloadLimiter(store);
  const watch = (contents: WebContents) => {
    limiter.watch(contents);
    guard.watch(contents);
  };
  for (const contents of allWebContents.getAllWebContents()) watch(contents);
  app.on("web-contents-created", (_event, contents) => watch(contents));
  session.prependListener("will-download", (event, _item, contents) => {
    if (contents && !contents.isDestroyed() && !limiter.allows(contents)) event.preventDefault();
  });

  const sound = new SoundMuter(store, session);
  service.onTabContents((contents, ref) =>
    sound.watch(contents, (muted) => {
      const handle = ref.tab.ref.current;
      if (handle) handle.setAudioMuted(muted);
      else contents.setAudioMuted(muted);
    }),
  );
  store.onChange(() => sound.applyAll());
}

// Like Chrome's sound setting: a tab whose page has a "block" rule is muted, and unmuted
// again when no rule asks for it, unless the user had muted it themselves.
export class SoundMuter {
  private readonly tabs = new Map<WebContents, (muted: boolean) => void>();
  private readonly mutedByRule = new WeakSet<WebContents>();

  constructor(
    private readonly store: ContentSettingsStore,
    private readonly session: Session,
  ) {}

  watch(contents: WebContents, setMuted: (muted: boolean) => void) {
    if (contents.session !== this.session || this.tabs.has(contents)) return;
    this.tabs.set(contents, setMuted);
    contents.once("destroyed", () => this.tabs.delete(contents));
    contents.on("did-navigate", () => this.apply(contents));
    this.apply(contents);
  }

  applyAll() {
    for (const contents of this.tabs.keys()) this.apply(contents);
  }

  apply(contents: WebContents) {
    const setMuted = this.tabs.get(contents);
    if (!setMuted || contents.isDestroyed()) return;
    const blocked = this.store.ruleForPage("sound", contents.getURL()) === "block";
    if (blocked && !contents.isAudioMuted()) {
      this.mutedByRule.add(contents);
      setMuted(true);
    } else if (!blocked && this.mutedByRule.delete(contents) && contents.isAudioMuted()) {
      setMuted(false);
    }
  }
}
