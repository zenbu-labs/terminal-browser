import { canonicalUrl } from "../../canonical-url";
import { INTERNAL_SCHEME } from "../../pages/internal";
import { browserMayReload } from "../../pages/local-navigation";
import { DOC_SCHEME } from "../../url";
import type { LoadedExtension } from "../loaded";
import { PatternSet, matchesGlob, matchesUrlPatternPath } from "../manifest";
import { captureVisiblePageError } from "./page-capture";
import type { Caller } from "../router";
import { WINDOW_ID_CURRENT } from "../service";
import type { ExtensionService } from "../service";
import type { ExtensionWindow, TabRef } from "../window";
import { setNativeZoomMode } from "../native";
import { nativeZoomMode, zoomSettings } from "../zoom";
import type { ZoomSettings } from "../zoom";

interface QueryInfo {
  active?: boolean;
  audible?: boolean;
  autoDiscardable?: boolean;
  currentWindow?: boolean;
  discarded?: boolean;
  frozen?: boolean;
  groupId?: number;
  highlighted?: boolean;
  index?: number;
  lastFocusedWindow?: boolean;
  muted?: boolean;
  pinned?: boolean;
  status?: "loading" | "complete" | "unloaded";
  title?: string;
  url?: string | string[];
  windowId?: number;
  windowType?: string;
}

const BLOCKED_SCHEMES = [
  "javascript:",
  "chrome:",
  "chrome-untrusted:",
  "devtools:",
  "file:",
  `${DOC_SCHEME}:`,
  "view-source:",
  "data:",
];

const UNTRANSLATABLE_SCHEMES = new Set(["chrome", "chrome-native", "devtools", INTERNAL_SCHEME]);

// Chrome's TranslateService::IsTranslatableURL, with our internal pages as its chrome:// pages.
function isTranslatableUrl(url: string): boolean {
  const parsed = canonicalUrl(url);
  if (!parsed || UNTRANSLATABLE_SCHEMES.has(parsed.scheme)) return false;
  return !(parsed.scheme === "about" && parsed.pathname === "blank");
}

// Like Chrome, a page of another extension is only reachable when that
// extension lists it in web_accessible_resources for the caller.
function webAccessibleTo(target: LoadedExtension, pathname: string, callerId: string): boolean {
  const entries = (target.manifest as { web_accessible_resources?: unknown }).web_accessible_resources;
  if (!Array.isArray(entries)) return false;
  const resource = decodeURIComponent(pathname);
  const matchesResource = (glob: unknown) => typeof glob === "string" && matchesUrlPatternPath(resource, `/${glob.replace(/^\/+/, "")}`);
  return entries.some((entry) => {
    if (typeof entry === "string") return matchesResource(entry);
    const { resources, extension_ids: ids } = entry as { resources?: unknown[]; extension_ids?: string[] };
    return (resources ?? []).some(matchesResource) && (ids?.includes("*") || ids?.includes(callerId) || false);
  });
}

// A page of another extension that it doesn't make web accessible to `extension`.
function otherExtensionPage(service: ExtensionService, extension: LoadedExtension, url: string): boolean {
  const resolved = canonicalUrl(url);
  if (resolved?.scheme !== "chrome-extension" || resolved.host === extension.id) return false;
  const target = service.get(resolved.host);
  return !target || !webAccessibleTo(target, resolved.pathname, extension.id);
}

export function extensionNavigableUrl(
  service: ExtensionService,
  extension: LoadedExtension,
  raw: string,
  { allowOtherExtensionPages = false } = {},
): string {
  if (extension.manifest.manifest_version >= 3 && /^\s*javascript:/i.test(raw)) {
    throw new Error("JavaScript URLs are not allowed in API based extension navigations. Use chrome.scripting.executeScript instead.");
  }
  const url = /^chrome:\/\//i.test(raw) ? raw.replace(/^chrome:/i, "terminal-browser:") : raw;
  const parsed = canonicalUrl(url, extension.baseUrl);
  if (!parsed) throw new Error(`Invalid url: "${raw}".`);
  if (BLOCKED_SCHEMES.includes(`${parsed.scheme}:`)) {
    throw new Error(`Cannot navigate to ${raw}.`);
  }
  if (!allowOtherExtensionPages && otherExtensionPage(service, extension, parsed.href)) {
    throw new Error(`Cannot navigate to ${raw}.`);
  }
  return parsed.href;
}

// Bookmarks and history entries open as the browser, so an extension may only store local files it could read
// itself, and never the url of a local document, which would skip the file access check.
export function extensionMayStoreUrl(extension: LoadedExtension, url: string): boolean {
  const scheme = canonicalUrl(url)?.scheme;
  if (scheme === DOC_SCHEME) return false;
  return scheme !== "file" || extension.allowsFileAccess;
}

export function installTabs(service: ExtensionService) {
  const { router } = service;

  const find = (tabId: unknown): TabRef => {
    if (typeof tabId !== "number") throw new Error("Tab id must be an integer.");
    const ref = service.tabRef(tabId);
    if (!ref) throw new Error(`No tab with id: ${tabId}.`);
    return ref;
  };

  const activeTabOf = (caller: Caller): TabRef => {
    const window = service.currentWindow(caller);
    const tab = window?.host.tabs.active;
    if (!window || !tab || tab.contentsId === null) throw new Error("No current tab.");
    return { window, tab };
  };

  const info = (extension: LoadedExtension, ref: TabRef) => service.tabInfo(extension, ref);

  const query = (caller: Caller, queryInfo: QueryInfo = {}) => {
    const extension = caller.extension;
    const current = service.currentWindow(caller);
    const lastFocused = service.lastFocusedWindow();
    const urls = queryInfo.url === undefined ? null : new PatternSet(Array.isArray(queryInfo.url) ? queryInfo.url : [queryInfo.url]);
    if (urls && urls.size === 0) throw new Error(`Invalid url pattern '${queryInfo.url}'`);
    const windowId = queryInfo.windowId === WINDOW_ID_CURRENT ? current?.id : queryInfo.windowId;
    const results: chrome.tabs.Tab[] = [];
    const windows: ExtensionWindow[] = service.allWindows();
    for (const window of windows) {
      if (windowId !== undefined && window.id !== windowId) continue;
      if (queryInfo.currentWindow !== undefined && (window === current) !== queryInfo.currentWindow) continue;
      if (queryInfo.lastFocusedWindow !== undefined && (window === lastFocused) !== queryInfo.lastFocusedWindow) continue;
      if (queryInfo.windowType !== undefined && queryInfo.windowType !== "normal") continue;
      for (const tab of window.host.tabs.all()) {
        if (tab.contentsId === null) continue;
        const tabInfo = info(extension, { window, tab });
        if (queryInfo.active !== undefined && tabInfo.active !== queryInfo.active) continue;
        if (queryInfo.highlighted !== undefined && tabInfo.highlighted !== queryInfo.highlighted) continue;
        if (queryInfo.audible !== undefined && tabInfo.audible !== queryInfo.audible) continue;
        if (queryInfo.muted !== undefined && tabInfo.mutedInfo?.muted !== queryInfo.muted) continue;
        if (queryInfo.pinned !== undefined && tabInfo.pinned !== queryInfo.pinned) continue;
        if (queryInfo.discarded !== undefined && tabInfo.discarded !== queryInfo.discarded) continue;
        if (queryInfo.frozen === true) continue;
        if (queryInfo.autoDiscardable !== undefined && tabInfo.autoDiscardable !== queryInfo.autoDiscardable) continue;
        if (queryInfo.groupId !== undefined && queryInfo.groupId !== -1) continue;
        if (queryInfo.status !== undefined && tabInfo.status !== queryInfo.status) continue;
        if (queryInfo.index !== undefined && tabInfo.index !== queryInfo.index) continue;
        if (urls && (tabInfo.url === undefined || !urls.matches(tabInfo.url))) continue;
        if (queryInfo.title !== undefined && (tabInfo.title === undefined || !matchesGlob(tabInfo.title, queryInfo.title))) continue;
        results.push(tabInfo);
      }
    }
    if (windowId === undefined || service.popupWindow(windowId)) {
      for (const entry of service.allPopupWindows()) {
        if (windowId !== undefined && entry.id !== windowId) continue;
        if (queryInfo.currentWindow || queryInfo.lastFocusedWindow) continue;
        if (queryInfo.windowType !== undefined && queryInfo.windowType !== "popup") continue;
        const tabInfo = service.popupTabInfo(extension, entry);
        if (queryInfo.active === false) continue;
        if (urls && (tabInfo.url === undefined || !urls.matches(tabInfo.url))) continue;
        results.push(tabInfo);
      }
    }
    return results;
  };

  const waitForReady = async (window: ExtensionWindow, tab: TabRef["tab"]) => {
    await window.host.tabs.whenReady(tab);
    return { window, tab };
  };

  router.handle("tabs.get", (caller, tabId) => {
    if (typeof tabId === "number") {
      const popup = service.popupWindowForContents(tabId);
      if (popup) return service.popupTabInfo(caller.extension, popup);
    }
    return info(caller.extension, find(tabId));
  });

  router.handle("tabs.getCurrent", (caller) => {
    if (caller.kind !== "frame") return undefined;
    const ref = service.tabRef(caller.contents.id);
    return ref ? info(caller.extension, ref) : undefined;
  });

  router.handle("tabs.query", (caller, queryInfo) => query(caller, (queryInfo ?? {}) as QueryInfo));

  router.handle("tabs.create", async (caller, properties) => {
    const props = (properties ?? {}) as chrome.tabs.CreateProperties;
    const window = service.resolveWindowId(caller, props.windowId);
    if (!window) throw new Error(`No window with id: ${props.windowId}.`);
    const url = props.url
      ? extensionNavigableUrl(service, caller.extension, props.url, { allowOtherExtensionPages: true })
      : window.host.resolveUrl("");
    const opener = props.openerTabId !== undefined ? service.tabRef(props.openerTabId) : null;
    const active = (props.active ?? props.selected ?? true) && !service.importer.justImported(caller.extension.id);
    // Like Chrome, the tab opens and the extension's navigation to the other extension's page is blocked there.
    const blocked = otherExtensionPage(service, caller.extension, url);
    const tab = window.host.tabs.create(blocked ? "about:blank" : url, active, {
      index: props.index,
      openerId: opener?.window === window ? opener.tab.id : null,
    });
    const ready = await waitForReady(window, tab);
    if (blocked) await service.loadForExtension(caller.extension, tab, url);
    return info(caller.extension, ready);
  });

  router.handle("tabs.duplicate", async (caller, tabId) => {
    const { window, tab } = find(tabId);
    const index = window.host.tabs.all().indexOf(tab) + 1;
    const asBrowser = browserMayReload(service.contentsOf(tab), tab.state.url);
    const copy = window.host.tabs.create(tab.state.url, true, {
      index,
      openerId: tab.id,
      initiator: asBrowser ? null : caller.extension.baseUrl,
    });
    return info(caller.extension, await waitForReady(window, copy));
  });

  router.handle("tabs.update", async (caller, first, second) => {
    const [tabId, properties] = typeof first === "number" ? [first, second] : [undefined, first];
    const ref = tabId === undefined ? activeTabOf(caller) : find(tabId);
    const props = (properties ?? {}) as chrome.tabs.UpdateProperties;
    if (props.url !== undefined) {
      const url = extensionNavigableUrl(service, caller.extension, props.url);
      if (ref.tab.contentsId !== null) service.tabStates.get(ref.tab.contentsId).navigatingFromExtension = true;
      void service.loadForExtension(caller.extension, ref.tab, url);
    }
    if (props.active || props.highlighted || props.selected) {
      ref.window.host.tabs.activate(ref.tab.id);
      ref.window.host.activate();
    }
    const extras = service.tabStates.get(ref.tab.contentsId ?? -1);
    if (props.muted !== undefined) {
      const mute = { muted: props.muted, reason: "extension" as const, extensionId: caller.extension.id };
      if (ref.tab.state.muted === props.muted) {
        extras.muted = { reason: mute.reason, extensionId: mute.extensionId };
        service.tabChanged(ref, { mutedInfo: mute });
      } else {
        extras.requestedMute = mute;
        ref.tab.ref.current?.setAudioMuted(props.muted);
      }
    }
    if (props.openerTabId !== undefined) {
      const opener = service.tabRef(props.openerTabId);
      if (!opener || opener.window !== ref.window) throw new Error(`No tab with id: ${props.openerTabId}.`);
      ref.tab.openerId = opener.tab.id;
    }
    if (props.pinned !== undefined) ref.window.host.tabs.setPinned(ref.tab.id, props.pinned);
    if (props.autoDiscardable !== undefined && props.autoDiscardable !== extras.autoDiscardable) {
      extras.autoDiscardable = props.autoDiscardable;
      service.tabChanged(ref, { autoDiscardable: props.autoDiscardable });
    }
    return info(caller.extension, ref);
  });

  router.handle("tabs.move", (caller, tabIds, moveProperties) => {
    const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
    const props = (moveProperties ?? {}) as { index: number; windowId?: number };
    const moved = ids.map((id, offset) => {
      const ref = find(id);
      if (props.windowId !== undefined && props.windowId !== ref.window.id) {
        throw new Error("Moving tabs between windows is not supported.");
      }
      ref.window.host.tabs.move(ref.tab.id, props.index === -1 ? -1 : props.index + offset);
      return info(caller.extension, ref);
    });
    return Array.isArray(tabIds) ? moved : moved[0];
  });

  router.handle("tabs.remove", (_caller, tabIds) => {
    const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
    const refs = ids.map((id) => {
      const popup = typeof id === "number" ? service.popupWindowForContents(id) : null;
      return popup ? { popup } : { ref: find(id) };
    });
    for (const target of refs) {
      if ("popup" in target && target.popup) target.popup.owner.host.closePopupWindow(target.popup.id);
      else if ("ref" in target && target.ref) target.ref.window.host.closeTab(target.ref.tab.id);
    }
  });

  router.handle("tabs.reload", (caller, first, second) => {
    const [tabId, props] = typeof first === "number" ? [first, second] : [undefined, first];
    const ref = tabId === undefined ? activeTabOf(caller) : find(tabId);
    const contents = service.contentsOf(ref.tab);
    if ((props as { bypassCache?: boolean } | undefined)?.bypassCache) contents?.reloadIgnoringCache();
    else contents?.reload();
  });

  router.handle("tabs.goBack", (caller, tabId) => {
    const ref = tabId === undefined ? activeTabOf(caller) : find(tabId);
    const history = service.contentsOf(ref.tab)?.navigationHistory;
    if (!history?.canGoBack()) throw new Error("Cannot find a next page in history.");
    history.goBack();
  });

  router.handle("tabs.goForward", (caller, tabId) => {
    const ref = tabId === undefined ? activeTabOf(caller) : find(tabId);
    const history = service.contentsOf(ref.tab)?.navigationHistory;
    if (!history?.canGoForward()) throw new Error("Cannot find a next page in history.");
    history.goForward();
  });

  router.handle("tabs.highlight", (caller, highlightInfo) => {
    const { windowId, tabs } = highlightInfo as { windowId?: number; tabs: number | number[] };
    const window = service.resolveWindowId(caller, windowId);
    if (!window) throw new Error(`No window with id: ${windowId}.`);
    const index = Array.isArray(tabs) ? tabs[0] : tabs;
    const tab = window.host.tabs.all()[index];
    if (!tab) throw new Error(`No tab at index: ${index}.`);
    window.host.tabs.activate(tab.id);
    return service.windowInfo(window, true, caller.extension);
  });

  const leastRecentlyUsed = (): TabRef => {
    const candidates = service.allTabs().filter(({ window, tab }) => {
      const extras = service.tabStates.peek(tab.contentsId ?? -1);
      return window.host.tabs.active !== tab && extras?.autoDiscardable !== false && !extras?.discarded;
    });
    const oldest = candidates.sort((a, b) => a.tab.lastAccessed - b.tab.lastAccessed)[0];
    if (!oldest) throw new Error("Cannot find a tab to discard.");
    return oldest;
  };

  // Electron can't unload a page and keep its tab id, so a discarded page is frozen
  // instead and, like Chrome's, reloaded once it is shown.
  router.handle("tabs.discard", async (caller, tabId) => {
    const ref = tabId === undefined ? leastRecentlyUsed() : find(tabId);
    const extras = service.tabStates.get(ref.tab.contentsId ?? -1);
    const active = ref.window.host.tabs.active === ref.tab;
    if (!extras.discarded) {
      // The active tab is reloaded right away, and a page that is still shown can't be frozen.
      if (!active) await ref.tab.ref.current?.cdp("Page.setWebLifecycleState", { state: "frozen" }).catch(() => {});
      extras.discarded = true;
      service.tabChanged(ref, { discarded: true });
    }
    const discarded = info(caller.extension, ref);
    if (active) service.reloadDiscarded(ref);
    return discarded;
  });

  router.handle("tabs.captureVisibleTab", async (caller, first, second) => {
    const [windowId, options] = typeof first === "number" || first === null ? [first, second] : [undefined, first];
    const window = service.resolveWindowId(caller, windowId ?? undefined);
    const tab = window?.host.tabs.active;
    if (!window || !tab || tab.contentsId === null) throw new Error("No active tab.");
    const denied = captureVisiblePageError(caller.extension, tab.contentsId, tab.state.url);
    if (denied) throw new Error(denied);
    const contents = service.contentsOf(tab);
    if (!contents) throw new Error("No active tab.");
    const image = await contents.capturePage();
    const { format, quality } = (options ?? {}) as { format?: "jpeg" | "png"; quality?: number };
    if (format === "png") return image.toDataURL();
    const jpeg = image.toJPEG(Math.max(0, Math.min(100, quality ?? 92)));
    return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  });

  router.handle("tabs.getZoom", (caller, tabId) => {
    const ref = tabId === undefined ? activeTabOf(caller) : find(tabId);
    return service.contentsOf(ref.tab)?.getZoomFactor() ?? 1;
  });

  router.handle("tabs.setZoom", (caller, first, second) => {
    const [tabId, factor] = second === undefined ? [undefined, first] : [first, second];
    const ref = tabId === undefined ? activeTabOf(caller) : find(tabId);
    const contents = service.contentsOf(ref.tab);
    if (!contents) return;
    if (contents.getZoomMode() === "disabled") throw new Error("Cannot zoom a tab in disabled mode.");
    contents.setZoomFactor(typeof factor === "number" && factor > 0 ? factor : 1);
  });

  router.handle("tabs.getZoomSettings", (caller, tabId) => {
    const ref = tabId === undefined ? activeTabOf(caller) : find(tabId);
    const contents = service.contentsOf(ref.tab);
    return { ...(contents ? zoomSettings(contents) : { mode: "automatic", scope: "per-origin" }), defaultZoomFactor: 1 };
  });

  router.handle("tabs.setZoomSettings", (caller, first, second) => {
    const [tabId, settings] = typeof first === "number" ? [first, second] : [undefined, first];
    const ref = tabId === undefined ? activeTabOf(caller) : find(tabId);
    const requested = (settings ?? {}) as Partial<ZoomSettings>;
    const mode = requested.mode === "manual" || requested.mode === "disabled" ? requested.mode : "automatic";
    if (requested.scope === "per-origin" && mode !== "automatic") {
      throw new Error('Can only set scope to "per-origin" in "automatic" mode.');
    }
    const scope = mode === "automatic" && requested.scope !== "per-tab" ? "per-origin" : "per-tab";
    const contents = service.contentsOf(ref.tab);
    if (contents) setNativeZoomMode(contents, nativeZoomMode({ mode, scope }), false);
  });

  router.handle("tabs.detectLanguage", async (caller, tabId) => {
    const ref = tabId === undefined ? activeTabOf(caller) : find(tabId);
    const contents = service.contentsOf(ref.tab);
    if (!contents) return "und";
    if (!isTranslatableUrl(contents.getURL())) throw new Error("Language detection is not supported for this page.");
    const lang = await contents.mainFrame
      .executeJavaScript("document.documentElement.lang || ''", false)
      .catch(() => "");
    return typeof lang === "string" && lang ? lang.split("-")[0].toLowerCase() : "und";
  });

  router.handle("tabs.group", () => {
    throw new Error("Tab groups are not supported.");
  });
  router.handle("tabs.ungroup", () => undefined);
}
