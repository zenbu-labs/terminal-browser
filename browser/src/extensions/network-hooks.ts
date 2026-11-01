import type {
  OnBeforeSendHeadersListenerDetails,
  OnHeadersReceivedListenerDetails,
  Session,
} from "electron";

export type SendHeadersHook = (details: OnBeforeSendHeadersListenerDetails, headers: Record<string, string>) => "cancel" | void;
export type HeadersReceivedHook = (details: OnHeadersReceivedListenerDetails, headers: Record<string, string[]>) => void;

// Electron keeps one webRequest listener per event and session, so every
// browser-wide setting that edits requests shares these. Listeners are only
// installed while some hook exists, so requests pay nothing by default.
export class NetworkHooks {
  private readonly sendHooks = new Set<SendHeadersHook>();
  private readonly receivedHooks = new Set<HeadersReceivedHook>();
  private sending = false;
  private receiving = false;

  constructor(private readonly session: Session) {}

  beforeSendHeaders(hook: SendHeadersHook): () => void {
    this.sendHooks.add(hook);
    this.sync();
    return () => {
      this.sendHooks.delete(hook);
      this.sync();
    };
  }

  headersReceived(hook: HeadersReceivedHook): () => void {
    this.receivedHooks.add(hook);
    this.sync();
    return () => {
      this.receivedHooks.delete(hook);
      this.sync();
    };
  }

  private sync() {
    const webRequest = this.session.webRequest;
    if (this.sendHooks.size > 0 !== this.sending) {
      this.sending = !this.sending;
      webRequest.onBeforeSendHeaders(this.sending ? (details, callback) => callback(this.runSend(details)) : null);
    }
    if (this.receivedHooks.size > 0 !== this.receiving) {
      this.receiving = !this.receiving;
      webRequest.onHeadersReceived(this.receiving ? (details, callback) => callback(this.runReceived(details)) : null);
    }
  }

  private runSend(details: OnBeforeSendHeadersListenerDetails) {
    const headers = { ...details.requestHeaders };
    for (const hook of [...this.sendHooks]) {
      try {
        if (hook(details, headers) === "cancel") return { cancel: true };
      } catch (error) {
        console.error(error);
      }
    }
    return { requestHeaders: headers };
  }

  private runReceived(details: OnHeadersReceivedListenerDetails) {
    if (!details.responseHeaders) return {};
    const headers = Object.fromEntries(Object.entries(details.responseHeaders).map(([name, values]) => [name, [...values]]));
    for (const hook of [...this.receivedHooks]) {
      try {
        hook(details, headers);
      } catch (error) {
        console.error(error);
      }
    }
    return { responseHeaders: headers };
  }
}

const hooks = new WeakMap<Session, NetworkHooks>();

export function networkHooks(session: Session): NetworkHooks {
  let found = hooks.get(session);
  if (!found) hooks.set(session, (found = new NetworkHooks(session)));
  return found;
}
