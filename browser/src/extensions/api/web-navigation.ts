import { app, webContents, webFrameMain } from "electron";
import type { WebContents, WebFrameMain } from "electron";

import { frameDocumentId, frameDocumentLifecycle } from "../native";
import type { ExtensionService } from "../service";
import { eventUrlFilterMatches } from "../url-filter";

const permission = "webNavigation";
const QUEUE_LIMIT = 100;
const QUEUE_WINDOW_MS = 15_000;

// Chromium's extension frame ids: 0 is a tab's main frame, other frames use
// their frame tree node id.
export function frameIdOf(frame: WebFrameMain): number {
  return frame.parent ? frame.frameTreeNodeId : 0;
}

export function frameForId(contents: WebContents, frameId: number): WebFrameMain | null {
  const main = contents.mainFrame;
  if (frameId === 0) return main;
  return main.framesInSubtree.find((frame) => frame.parent && frame.frameTreeNodeId === frameId) ?? null;
}

// Chromium accepts either case and treats the all-zero id as no id.
function parseDocumentId(documentId: string): string | null {
  if (!/^[0-9A-Fa-f]{32}$/.test(documentId) || /^0+$/.test(documentId)) return null;
  return documentId.toUpperCase();
}

// Chrome's webNavigation hides documents with other schemes, such as extension pages, everywhere but onCommitted.
const NAVIGATION_SCHEMES = new Set(["chrome:", "http:", "https:", "file:", "ftp:", "javascript:", "data:", "filesystem:"]);

function reportsNavigation(url: string): boolean {
  if (url === "about:srcdoc" || /^about:blank([?#]|$)/.test(url)) return true;
  return URL.canParse(url) && NAVIGATION_SCHEMES.has(new URL(url).protocol);
}

export function frameForDocument(service: ExtensionService, rawDocumentId: string): { contents: WebContents; frame: WebFrameMain } | null {
  const documentId = parseDocumentId(rawDocumentId);
  if (!documentId) return null;
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed() || contents.session !== service.session) continue;
    const frame = contents.mainFrame.framesInSubtree.find((candidate) => frameDocumentId(candidate) === documentId);
    if (frame) return { contents, frame };
  }
  return null;
}

interface FrameState {
  url: string;
  errorOccurred: boolean;
  committed: boolean;
  redirected: boolean;
  rendererInitiated: boolean;
}

// Turns a tab's navigations into chrome.webNavigation events.
class TabNavigation {
  private readonly frames = new Map<number, FrameState>();
  private readonly queue: (() => void)[] = [];
  private readonly createdAt = Date.now();

  constructor(
    private readonly service: ExtensionService,
    readonly contents: WebContents,
  ) {
    contents.on("did-start-navigation", (details) => this.started(details));
    contents.on("did-redirect-navigation", (details) => {
      if (!details.isSameDocument && details.frame) this.state(details.frame).redirected = true;
    });
    contents.on("did-frame-navigate", (_event, url, _code, _status, _main, processId, routingId) =>
      this.committed(webFrameMain.fromId(processId, routingId), url),
    );
    contents.on("did-navigate-in-page", (_event, url, _main, processId, routingId) =>
      this.inPage(webFrameMain.fromId(processId, routingId), url),
    );
    contents.on("dom-ready", () => this.frameEvent("onDOMContentLoaded", contents.mainFrame));
    contents.on("frame-created", (_event, { frame }) => {
      if (!frame?.parent) return;
      frame.on("dom-ready", () => {
        if (!frame.isDestroyed()) this.frameEvent("onDOMContentLoaded", frame);
      });
    });
    contents.on("did-frame-finish-load", (_event, _main, processId, routingId) => {
      const frame = webFrameMain.fromId(processId, routingId);
      if (frame) this.frameEvent("onCompleted", frame);
    });
    // Electron reports a failed navigation as did-fail-load too, so that's the only one needed.
    contents.on("did-fail-load", (_event, code, description, url, _main, processId, routingId) => {
      const frame = webFrameMain.fromId(processId, routingId);
      if (frame) this.failed(frame, code, description, url);
    });
  }

  isTab(): boolean {
    return this.service.tabRef(this.contents.id) !== null;
  }

  flush() {
    for (const run of this.queue.splice(0)) run();
  }

  state(frame: WebFrameMain): FrameState {
    const id = frame.frameTreeNodeId;
    let state = this.frames.get(id);
    if (!state) {
      state = { url: frame.url, errorOccurred: false, committed: false, redirected: false, rendererInitiated: false };
      this.frames.set(id, state);
    }
    return state;
  }

  private emit(name: string, url: string, details: Record<string, unknown>) {
    const payload = { ...details, timeStamp: Date.now() };
    const run = () => {
      this.service.broadcast(
        `webNavigation.${name}`,
        (extension) => (extension.hasApiPermission(permission) ? [payload] : null),
        (filter) => eventUrlFilterMatches(filter, url),
      );
    };
    if (this.isTab()) {
      run();
      return;
    }
    if (this.queue.length < QUEUE_LIMIT && Date.now() - this.createdAt < QUEUE_WINDOW_MS) this.queue.push(run);
  }

  frameDetails(frame: WebFrameMain, withProcess = true): Record<string, unknown> {
    const details: Record<string, unknown> = {
      tabId: this.contents.id,
      frameId: frameIdOf(frame),
      parentFrameId: frame.parent ? frameIdOf(frame.parent) : -1,
      documentId: frameDocumentId(frame),
      frameType: frame.parent ? "sub_frame" : "outermost_frame",
      documentLifecycle: frameDocumentLifecycle(frame),
    };
    if (withProcess) details.processId = frame.processId;
    if (frame.parent) details.parentDocumentId = frameDocumentId(frame.parent);
    return details;
  }

  private started(details: Electron.WebContentsDidStartNavigationEventParams) {
    const frame = details.frame;
    if (!frame || details.isSameDocument || !reportsNavigation(details.url)) return;
    const state = this.state(frame);
    state.redirected = false;
    state.rendererInitiated = Boolean(details.initiator);
    const url = details.url;
    const { documentId: _documentId, ...rest } = this.frameDetails(frame, false);
    this.emit("onBeforeNavigate", url, { ...rest, url, processId: -1 });
  }

  private transition(frame: WebFrameMain, state: FrameState, url: string): { transitionType: string; transitionQualifiers: string[] } {
    const qualifiers: string[] = [];
    if (state.redirected) qualifiers.push("server_redirect");
    if (frame.parent) return { transitionType: state.committed ? "manual_subframe" : "auto_subframe", transitionQualifiers: qualifiers };
    if (state.committed && state.url === url && !state.rendererInitiated) return { transitionType: "reload", transitionQualifiers: qualifiers };
    if (state.rendererInitiated) return { transitionType: "link", transitionQualifiers: qualifiers };
    return { transitionType: "typed", transitionQualifiers: [...qualifiers, "from_address_bar"] };
  }

  private committed(frame: WebFrameMain | null | undefined, url: string) {
    if (!frame) return;
    const state = this.state(frame);
    const transition = this.transition(frame, state, url);
    state.url = url;
    state.errorOccurred = false;
    state.committed = true;
    for (const child of frame.frames) this.frames.delete(child.frameTreeNodeId);
    this.emit("onCommitted", url, { ...this.frameDetails(frame), url, ...transition });
  }

  private inPage(frame: WebFrameMain | null | undefined, url: string) {
    if (!frame) return;
    const state = this.state(frame);
    const strip = (value: string) => value.replace(/#.*$/, "");
    const fragmentOnly = strip(state.url) === strip(url) && state.url !== url;
    state.url = url;
    const transition = { transitionType: frame.parent ? "manual_subframe" : "link", transitionQualifiers: [] as string[] };
    this.emit(fragmentOnly ? "onReferenceFragmentUpdated" : "onHistoryStateUpdated", url, {
      ...this.frameDetails(frame),
      url,
      ...transition,
    });
  }

  // Like Chrome, a frame whose navigation failed reports nothing more until its next navigation.
  private frameEvent(name: string, frame: WebFrameMain) {
    const url = frame.url;
    if (this.state(frame).errorOccurred || !reportsNavigation(url)) return;
    this.emit(name, url, { ...this.frameDetails(frame), url });
  }

  private failed(frame: WebFrameMain, code: number, description: string, url: string) {
    const state = this.state(frame);
    state.errorOccurred = true;
    const error = `net::${description.startsWith("ERR_") ? description : `ERR_${code}`}`;
    this.emit("onErrorOccurred", url, { ...this.frameDetails(frame), url, error });
  }

  frameInfo(frame: WebFrameMain, withFrameId: boolean): Record<string, unknown> {
    const state = this.state(frame);
    const info: Record<string, unknown> = {
      errorOccurred: state.errorOccurred,
      url: frame.url,
      parentFrameId: frame.parent ? frameIdOf(frame.parent) : -1,
      documentId: frameDocumentId(frame),
      frameType: frame.parent ? "sub_frame" : "outermost_frame",
      documentLifecycle: frameDocumentLifecycle(frame),
    };
    if (frame.parent) info.parentDocumentId = frameDocumentId(frame.parent);
    if (withFrameId) {
      info.frameId = frameIdOf(frame);
      info.processId = frame.processId;
    }
    return info;
  }

}

export function installWebNavigation(service: ExtensionService) {
  const { router } = service;
  const tabs = new Map<number, TabNavigation>();

  const watch = (contents: WebContents) => {
    if (tabs.has(contents.id) || contents.session !== service.session) return tabs.get(contents.id) ?? null;
    const navigation = new TabNavigation(service, contents);
    tabs.set(contents.id, navigation);
    const id = contents.id;
    contents.once("destroyed", () => tabs.delete(id));
    return navigation;
  };

  app.on("web-contents-created", (_event, contents) => watch(contents));

  service.onTabContents((contents, ref) => {
    const navigation = watch(contents);
    const opener = ref.tab.openerId !== null ? ref.window.host.tabs.get(ref.tab.openerId) : null;
    const source = opener ? service.contentsOf(opener) : null;
    if (source) {
      const details = {
        sourceTabId: source.id,
        sourceProcessId: source.mainFrame.processId,
        sourceFrameId: 0,
        url: ref.tab.url,
        tabId: contents.id,
        timeStamp: Date.now(),
      };
      service.broadcast(
        "webNavigation.onCreatedNavigationTarget",
        (extension) => (extension.hasApiPermission(permission) ? [details] : null),
        (filter) => eventUrlFilterMatches(filter, details.url),
      );
    }
    navigation?.flush();
  });

  const tabNavigation = (tabId: unknown): TabNavigation | null => {
    if (typeof tabId !== "number") return null;
    const ref = service.tabRef(tabId);
    const contents = ref ? service.contentsOf(ref.tab) : null;
    return contents ? watch(contents) : null;
  };

  router.handle(
    "webNavigation.getFrame",
    (_caller, value) => {
      const { tabId, frameId, documentId } = (value ?? {}) as { tabId?: number; frameId?: number; documentId?: string };
      if (documentId !== undefined) {
        if (!parseDocumentId(documentId)) throw new Error("Invalid documentId.");
        const found = frameForDocument(service, documentId);
        const navigation = found ? tabNavigation(found.contents.id) : null;
        if (!found || !navigation || !reportsNavigation(found.frame.url)) return null;
        if (tabId !== undefined && tabId !== found.contents.id) return null;
        if (frameId !== undefined && frameId !== frameIdOf(found.frame)) return null;
        return navigation.frameInfo(found.frame, false);
      }
      if (tabId === undefined || frameId === undefined) throw new Error("Either documentId or both tabId and frameId must be specified.");
      const navigation = tabNavigation(tabId);
      const frame = navigation ? frameForId(navigation.contents, frameId) : null;
      if (!navigation || !frame || !reportsNavigation(frame.url)) return null;
      return navigation.frameInfo(frame, false);
    },
    { permission },
  );

  router.handle(
    "webNavigation.getAllFrames",
    (_caller, value) => {
      const { tabId } = (value ?? {}) as { tabId?: number };
      const navigation = tabNavigation(tabId);
      if (!navigation) return null;
      return navigation.contents.mainFrame.framesInSubtree.filter((frame) => reportsNavigation(frame.url)).map((frame) => navigation.frameInfo(frame, true));
    },
    { permission },
  );
}
