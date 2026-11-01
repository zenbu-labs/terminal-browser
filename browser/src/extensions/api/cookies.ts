import type { Cookie, CookiesSetDetails } from "electron";

import type { LoadedExtension } from "../loaded";
import type { ExtensionService } from "../service";
import { frameForDocument, frameForId, frameIdOf } from "./web-navigation";

const STORE_ID = "0";
const permission = "cookies";

interface CookieDetails {
  url?: string;
  name?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  session?: boolean;
  storeId?: string;
  partitionKey?: { topLevelSite?: string; hasCrossSiteAncestor?: boolean };
  value?: string;
  httpOnly?: boolean;
  sameSite?: string;
  expirationDate?: number;
}

const CAUSES: Record<string, string> = {
  inserted: "explicit",
  "inserted-no-change-overwrite": "explicit",
  "inserted-no-value-change-overwrite": "explicit",
  explicit: "explicit",
  overwrite: "overwrite",
  expired: "expired",
  evicted: "evicted",
  "expired-overwrite": "expired_overwrite",
};

// The URL Chrome checks host permissions against for a cookie.
export function cookieUrl(cookie: { domain?: string; secure?: boolean }): string {
  const host = (cookie.domain ?? "").replace(/^\./, "");
  return `${cookie.secure ? "https" : "http"}://${host}/`;
}

function chromeCookie(cookie: Cookie): chrome.cookies.Cookie {
  const result: chrome.cookies.Cookie = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain ?? "",
    hostOnly: cookie.hostOnly ?? !(cookie.domain ?? "").startsWith("."),
    path: cookie.path ?? "/",
    secure: cookie.secure ?? false,
    httpOnly: cookie.httpOnly ?? false,
    sameSite: (cookie.sameSite ?? "unspecified") as chrome.cookies.SameSiteStatus,
    session: cookie.session ?? cookie.expirationDate === undefined,
    storeId: STORE_ID,
  };
  if (!result.session && cookie.expirationDate !== undefined) result.expirationDate = cookie.expirationDate;
  return result;
}

function checkStore(storeId: string | undefined) {
  if (storeId !== undefined && storeId !== STORE_ID) throw new Error(`Invalid cookie store id: "${storeId}".`);
}

function parseUrl(raw: unknown): URL {
  try {
    return new URL(String(raw));
  } catch {
    throw new Error(`Invalid url: "${raw}".`);
  }
}

function checkHost(extension: LoadedExtension, url: URL) {
  if (!extension.hasHostAccess(url.href)) throw new Error(`No host permissions for cookies at url: "${url.href}".`);
}

function domainMatches(cookieDomain: string, filter: string): boolean {
  const domain = cookieDomain.replace(/^\./, "").toLowerCase();
  const wanted = filter.replace(/^\./, "").toLowerCase();
  return domain === wanted || domain.endsWith(`.${wanted}`);
}

// A rough registrable domain: Electron doesn't expose the public suffix list.
function site(url: URL): string {
  const host = url.hostname;
  if (/^[\d.]+$/.test(host) || host.includes(":") || !host.includes(".")) return `${url.protocol}//${host}`;
  const labels = host.split(".");
  const short = labels.length > 2 && labels[labels.length - 1].length === 2 && labels[labels.length - 2].length <= 3;
  return `${url.protocol}//${labels.slice(short ? -3 : -2).join(".")}`;
}

export function installCookies(service: ExtensionService) {
  const { router } = service;
  const cookies = service.session.cookies;

  const matching = async (url: URL, name: string) => {
    const found = await cookies.get({ url: url.href, name });
    return found.sort((a, b) => (b.path ?? "").length - (a.path ?? "").length);
  };

  router.handle(
    "cookies.get",
    async (caller, value) => {
      const details = (value ?? {}) as CookieDetails;
      const url = parseUrl(details.url);
      checkHost(caller.extension, url);
      checkStore(details.storeId);
      if (details.partitionKey?.topLevelSite) return null;
      const [cookie] = await matching(url, String(details.name ?? ""));
      return cookie ? chromeCookie(cookie) : null;
    },
    { permission },
  );

  router.handle(
    "cookies.getAll",
    async (caller, value) => {
      const details = (value ?? {}) as CookieDetails;
      const url = details.url !== undefined ? parseUrl(details.url) : null;
      checkStore(details.storeId);
      if (details.partitionKey?.topLevelSite) return [];
      const filter: Electron.CookiesGetFilter = {};
      if (url) filter.url = url.href;
      if (details.name !== undefined) filter.name = details.name;
      if (details.path !== undefined) filter.path = details.path;
      if (details.secure !== undefined) filter.secure = details.secure;
      if (details.session !== undefined) filter.session = details.session;
      const found = await cookies.get(filter);
      return found
        .filter((cookie) => details.domain === undefined || domainMatches(cookie.domain ?? "", details.domain))
        .filter((cookie) => caller.extension.hasHostAccess(cookieUrl(cookie)))
        .map(chromeCookie);
    },
    { permission },
  );

  router.handle(
    "cookies.set",
    async (caller, value) => {
      const details = (value ?? {}) as CookieDetails;
      const url = parseUrl(details.url);
      checkHost(caller.extension, url);
      checkStore(details.storeId);
      const name = details.name ?? "";
      const set: CookiesSetDetails = { url: url.href, name, value: details.value ?? "" };
      if (details.domain !== undefined) set.domain = details.domain;
      if (details.path !== undefined) set.path = details.path;
      if (details.secure !== undefined) set.secure = details.secure;
      if (details.httpOnly !== undefined) set.httpOnly = details.httpOnly;
      if (details.expirationDate !== undefined) set.expirationDate = details.expirationDate;
      if (details.sameSite !== undefined) set.sameSite = details.sameSite as CookiesSetDetails["sameSite"];
      try {
        await cookies.set(set);
      } catch {
        throw new Error(`Failed to parse or set cookie named "${name}".`);
      }
      const found = await cookies.get({ url: url.href, name });
      const wantedPath = details.path;
      const cookie =
        found.find((c) => (wantedPath === undefined || c.path === wantedPath) && (details.domain === undefined || domainMatches(c.domain ?? "", details.domain))) ??
        found[0];
      return cookie ? chromeCookie(cookie) : null;
    },
    { permission },
  );

  router.handle(
    "cookies.remove",
    async (caller, value) => {
      const details = (value ?? {}) as CookieDetails;
      const url = parseUrl(details.url);
      checkHost(caller.extension, url);
      checkStore(details.storeId);
      const name = String(details.name ?? "");
      await cookies.remove(url.href, name);
      const result: Record<string, unknown> = { url: url.href, name, storeId: STORE_ID };
      if (details.partitionKey) result.partitionKey = details.partitionKey;
      return result;
    },
    { permission },
  );

  router.handle(
    "cookies.getAllCookieStores",
    () => {
      const tabIds = [
        ...service.allTabs().map(({ tab }) => tab.contentsId!),
        ...service.allPopupWindows().map((entry) => entry.contents.id),
      ];
      return [{ id: STORE_ID, tabIds }];
    },
    { permission },
  );

  const documentFrame = (documentId: string, tabId: number | undefined, frameId: number | undefined) => {
    const found = frameForDocument(service, documentId);
    if (!found) throw new Error("Invalid `documentId`.");
    if (tabId !== undefined && (found.contents.id !== tabId || frameIdOf(found.frame) !== (frameId ?? 0))) {
      throw new Error("Provided `tabId` and `frameId` do not match the frame.");
    }
    return found;
  };

  const tabFrame = (tabId: number | undefined, frameId: number | undefined) => {
    if (tabId === undefined) throw new Error("Invalid tabId: undefined");
    const ref = service.tabRef(tabId);
    const contents = ref ? service.contentsOf(ref.tab) : null;
    if (!contents) throw new Error(`No tab with id: ${tabId}.`);
    const frame = frameForId(contents, frameId ?? 0);
    if (!frame) throw new Error(`No frame with id ${frameId} in tab with id ${tabId}`);
    return { contents, frame };
  };

  router.handle(
    "cookies.getPartitionKey",
    (caller, value) => {
      const { tabId, frameId, documentId } = (value ?? {}) as { tabId?: number; frameId?: number; documentId?: string };
      const { contents, frame } = documentId !== undefined ? documentFrame(documentId, tabId, frameId) : tabFrame(tabId, frameId);
      const frameUrl = parseUrl(frame.url);
      if (!caller.extension.hasHostAccess(frameUrl.href)) throw new Error(`No host permissions for cookies at url: "${frameUrl.href}".`);
      const top = parseUrl(contents.getURL());
      let crossSite = false;
      for (let at = frame.parent; at; at = at.parent) {
        if (site(parseUrl(at.url)) !== site(frameUrl)) crossSite = true;
      }
      return { partitionKey: { topLevelSite: site(top), hasCrossSiteAncestor: crossSite } };
    },
    { permission },
  );

  cookies.on("changed", (_event, cookie, cause, removed) => {
    const url = cookieUrl(cookie);
    const info = { removed, cookie: chromeCookie(cookie), cause: CAUSES[cause] ?? "explicit" };
    service.broadcast("cookies.onChanged", (extension) =>
      extension.hasApiPermission(permission) && extension.hasHostAccess(url) ? [info] : null,
    );
  });
}
