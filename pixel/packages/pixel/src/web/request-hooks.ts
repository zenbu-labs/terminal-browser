import type {
  BeforeSendResponse,
  CallbackResponse,
  HeadersReceivedResponse,
  OnBeforeRedirectListenerDetails,
  OnBeforeRequestListenerDetails,
  OnBeforeSendHeadersListenerDetails,
  OnHeadersReceivedListenerDetails,
  Session,
} from "electron";

export interface RequestFilter {
  urls: string[];
}
export type BeforeRequestHook = (details: OnBeforeRequestListenerDetails) => { cancel?: boolean; redirectURL?: string } | void;
export type SendHeadersHook = (details: OnBeforeSendHeadersListenerDetails, headers: Record<string, string>) => "cancel" | void;
export type HeadersReceivedHook = (details: OnHeadersReceivedListenerDetails, headers: Record<string, string[]>) => void;
export type BeforeRedirectHook = (details: OnBeforeRedirectListenerDetails) => void;

interface BeforeRequestEntry {
  urls: string[];
  hook: BeforeRequestHook;
}

function wildcardMatches(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      resume = t;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (star >= 0) {
      p = star + 1;
      t = ++resume;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

// The match patterns Electron's request filters take: scheme://host/path, where "*" as the
// scheme means http or https, "*" or "*.example.com" widens the host, and "*" in the path matches anything.
export function urlPatternMatches(pattern: string, url: string): boolean {
  if (pattern === "<all_urls>") return true;
  const split = /^([^:/]+):\/\/([^/]*)(.*)$/;
  const want = split.exec(pattern);
  const have = split.exec(url);
  if (!want || !have) return false;
  const [, scheme, host, path] = want;
  const [, urlScheme, urlHostPort, urlPath] = have;
  if (scheme === "*" ? urlScheme !== "http" && urlScheme !== "https" : scheme.toLowerCase() !== urlScheme.toLowerCase()) return false;
  const urlHost = urlHostPort.toLowerCase().replace(/^[^@]*@/, "").replace(/:\d*$/, "");
  const wantHost = host.toLowerCase().replace(/:\d*$/, "");
  const hostOk =
    wantHost === "*" ||
    (wantHost.startsWith("*.") ? urlHost === wantHost.slice(2) || urlHost.endsWith(wantHost.slice(1)) : urlHost === wantHost);
  return hostOk && wildcardMatches(path || "*", urlPath.split("#")[0] || "/");
}

// Electron keeps one webRequest listener per event and session, so pixel and every app built on it
// register here instead. A listener is installed only while some hook exists, so requests pay
// nothing by default, and each registration can only remove itself.
export class RequestHooks {
  private readonly beforeRequestHooks = new Set<BeforeRequestEntry>();
  private readonly sendHooks = new Set<{ hook: SendHeadersHook }>();
  private readonly receivedHooks = new Set<{ hook: HeadersReceivedHook }>();
  private readonly redirectHooks = new Set<{ hook: BeforeRedirectHook }>();
  private beforeRequestUrls = "";
  private sending = false;
  private receiving = false;
  private redirecting = false;

  constructor(private readonly session: Session) {}

  beforeRequest(filter: RequestFilter, hook: BeforeRequestHook): () => void {
    const entry = { urls: [...filter.urls], hook };
    this.beforeRequestHooks.add(entry);
    this.sync();
    return () => {
      if (this.beforeRequestHooks.delete(entry)) this.sync();
    };
  }

  beforeSendHeaders(hook: SendHeadersHook): () => void {
    const entry = { hook };
    this.sendHooks.add(entry);
    this.sync();
    return () => {
      if (this.sendHooks.delete(entry)) this.sync();
    };
  }

  headersReceived(hook: HeadersReceivedHook): () => void {
    const entry = { hook };
    this.receivedHooks.add(entry);
    this.sync();
    return () => {
      if (this.receivedHooks.delete(entry)) this.sync();
    };
  }

  beforeRedirect(hook: BeforeRedirectHook): () => void {
    const entry = { hook };
    this.redirectHooks.add(entry);
    this.sync();
    return () => {
      if (this.redirectHooks.delete(entry)) this.sync();
    };
  }

  private sync() {
    const webRequest = this.session.webRequest;
    const urls = [...new Set([...this.beforeRequestHooks].flatMap((entry) => entry.urls))].sort();
    const key = urls.join("\n");
    if (key !== this.beforeRequestUrls) {
      this.beforeRequestUrls = key;
      if (urls.length) webRequest.onBeforeRequest({ urls }, (details, callback) => callback(this.runBeforeRequest(details)));
      else webRequest.onBeforeRequest(null);
    }
    if (this.sendHooks.size > 0 !== this.sending) {
      this.sending = !this.sending;
      webRequest.onBeforeSendHeaders(this.sending ? (details, callback) => callback(this.runSend(details)) : null);
    }
    if (this.receivedHooks.size > 0 !== this.receiving) {
      this.receiving = !this.receiving;
      webRequest.onHeadersReceived(this.receiving ? (details, callback) => callback(this.runReceived(details)) : null);
    }
    if (this.redirectHooks.size > 0 !== this.redirecting) {
      this.redirecting = !this.redirecting;
      webRequest.onBeforeRedirect(this.redirecting ? (details) => this.runRedirect(details) : null);
    }
  }

  private runBeforeRequest(details: OnBeforeRequestListenerDetails): CallbackResponse {
    let redirectURL: string | undefined;
    for (const entry of [...this.beforeRequestHooks]) {
      if (!entry.urls.some((pattern) => urlPatternMatches(pattern, details.url))) continue;
      try {
        const response = entry.hook(details);
        if (response?.cancel) return { cancel: true };
        redirectURL ??= response?.redirectURL;
      } catch (error) {
        console.error(error);
        return { cancel: true };
      }
    }
    return redirectURL ? { redirectURL } : {};
  }

  private runSend(details: OnBeforeSendHeadersListenerDetails): BeforeSendResponse {
    const headers = { ...details.requestHeaders };
    for (const { hook } of [...this.sendHooks]) {
      try {
        if (hook(details, headers) === "cancel") return { cancel: true };
      } catch (error) {
        console.error(error);
      }
    }
    return { requestHeaders: headers };
  }

  private runRedirect(details: OnBeforeRedirectListenerDetails) {
    for (const { hook } of [...this.redirectHooks]) {
      try {
        hook(details);
      } catch (error) {
        console.error(error);
      }
    }
  }

  private runReceived(details: OnHeadersReceivedListenerDetails): HeadersReceivedResponse {
    if (!details.responseHeaders) return {};
    const headers = Object.fromEntries(Object.entries(details.responseHeaders).map(([name, values]) => [name, [...values]]));
    for (const { hook } of [...this.receivedHooks]) {
      try {
        hook(details, headers);
      } catch (error) {
        console.error(error);
      }
    }
    return { responseHeaders: headers };
  }
}

const hubs = new WeakMap<Session, RequestHooks>();

export function requestHooks(session: Session): RequestHooks {
  let found = hubs.get(session);
  if (!found) hubs.set(session, (found = new RequestHooks(session)));
  return found;
}
