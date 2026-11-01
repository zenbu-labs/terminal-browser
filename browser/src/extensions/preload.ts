// Runs in every frame and service worker of the browsing session. It only does
// anything inside chrome-extension:// contexts, where it replaces the chrome.*
// APIs Electron lacks with versions answered by the main process. Sandboxed
// preloads can only require "electron", so this file must stay self-contained.
import { contextBridge, ipcRenderer } from "electron";

import {
  API_EVENTS,
  API_METHODS,
  API_SPEC,
  EVENT_CHANNEL,
  LISTEN_CHANNEL,
  READY_CHANNEL,
  UNLISTEN_CHANNEL,
  channelFor,
} from "./protocol";
import type { ApiSpec } from "./protocol";

type Listener = (name: string, args: unknown[], matched: number[] | undefined) => void;

interface BridgeShape {
  invoke(method: string, args: unknown[]): Promise<unknown>;
  listen(event: string, key?: number, filter?: unknown): void;
  unlisten(event: string, key?: number): void;
  onEvent(listener: Listener): void;
  ready(): void;
}

const ERROR_PREFIX = /^Error invoking remote method '[^']*': (?:Error: )?/;

const bridge: BridgeShape = {
  invoke(method: string, args: unknown[]): Promise<unknown> {
    if (!API_METHODS.has(method)) return Promise.reject(new Error(`unknown method ${method}`));
    return ipcRenderer.invoke(channelFor(method), ...args).catch((error: Error) => {
      throw new Error(String(error?.message ?? error).replace(ERROR_PREFIX, ""));
    });
  },
  listen(event: string, key?: number, filter?: unknown) {
    if (API_EVENTS.has(event)) ipcRenderer.send(LISTEN_CHANNEL, event, key, filter);
  },
  unlisten(event: string, key?: number) {
    if (API_EVENTS.has(event)) ipcRenderer.send(UNLISTEN_CHANNEL, event, key);
  },
  onEvent(listener: Listener) {
    ipcRenderer.on(EVENT_CHANNEL, (_event, name: string, args: unknown[], matched?: number[]) =>
      listener(name, args, matched ?? undefined),
    );
  },
  ready() {
    ipcRenderer.send(READY_CHANNEL);
  },
};

// Offscreen documents run without context isolation, and like in Chrome they
// only get the chrome.runtime that Chromium already provides.
if (process.contextIsolated) {
  contextBridge.executeInMainWorld({
    func: installChromeApis,
    args: [bridge, process.type === "service-worker", API_SPEC],
  });
}

// Serialized into the page's own JavaScript world, so it can't use anything
// from the surrounding module.
function installChromeApis(bridge: BridgeShape, isWorker: boolean, spec: ApiSpec): boolean {
  type Fn = (...args: unknown[]) => unknown;
  if (globalThis.location?.protocol !== "chrome-extension:") return false;
  const g = globalThis as unknown as { chrome: Record<string, Record<string, unknown>> };
  const chrome = g.chrome;
  if (!chrome || !chrome.runtime) return false;
  // runs once the extension's own top-level script has finished
  setTimeout(() => bridge.ready(), 0);
  const manifest = (chrome.runtime.getManifest as () => Record<string, unknown>)();
  const id = chrome.runtime.id as string;
  const declared = new Set<string>([
    ...((manifest.permissions as string[] | undefined) ?? []),
    ...((manifest.optional_permissions as string[] | undefined) ?? []),
  ]);

  // Chromium deletes chrome.runtime.lastError after each of its own failed
  // calls, so ours only exists while one of our callbacks runs, like Chrome's.
  function withLastError(error: Error, callback: Fn) {
    const lastError = { message: error.message };
    let checked = false;
    try {
      Object.defineProperty(chrome.runtime, "lastError", {
        configurable: true,
        enumerable: true,
        get() {
          checked = true;
          return lastError;
        },
      });
    } catch {}
    try {
      callback();
    } finally {
      delete chrome.runtime.lastError;
      if (!checked) console.error(`Unchecked runtime.lastError: ${error.message}`);
    }
  }

  function call(method: string, args: unknown[]): Promise<unknown> {
    return bridge.invoke(method, args);
  }

  function method(name: string): Fn {
    return function (this: unknown, ...args: unknown[]) {
      const callback = typeof args[args.length - 1] === "function" ? (args.pop() as Fn) : null;
      while (args.length > 0 && args[args.length - 1] === undefined) args.pop();
      const result = call(name, args);
      if (!callback) return result;
      result.then(
        (value) => callback(value),
        (error: Error) => withLastError(error, () => callback()),
      );
      return undefined;
    };
  }

  const events = new Map<string, Set<Fn>>();
  // Filtered listeners per event, keyed so the main process can say which matched.
  const filterKeys = new Map<string, Map<Fn, number>>();
  let nextFilterKey = 1;

  class LocalEvent {
    constructor(protected readonly listeners: Set<Fn> = new Set()) {}
    addListener(listener: Fn) {
      if (typeof listener !== "function") throw new TypeError("listener must be a function");
      this.listeners.add(listener);
    }
    removeListener(listener: Fn) {
      this.listeners.delete(listener);
    }
    hasListener(listener: Fn) {
      return this.listeners.has(listener);
    }
    hasListeners() {
      return this.listeners.size > 0;
    }
    dispatch(...args: unknown[]) {
      for (const listener of [...this.listeners]) {
        try {
          listener(...args);
        } catch (error) {
          console.error(error);
        }
      }
    }
  }

  class ExtensionEvent extends LocalEvent {
    private readonly keys: Map<Fn, number>;
    constructor(
      private readonly name: string,
      private readonly filterable = false,
    ) {
      super(events.get(name) ?? new Set());
      events.set(name, this.listeners);
      this.keys = filterKeys.get(name) ?? new Map();
      filterKeys.set(name, this.keys);
    }
    private unfilteredCount() {
      return this.listeners.size - this.keys.size;
    }
    addListener(listener: Fn, filter?: unknown) {
      if (filter !== undefined && filter !== null && !this.filterable) {
        throw new Error("This event does not support filters");
      }
      if (this.listeners.has(listener)) return;
      super.addListener(listener);
      if (filter !== undefined && filter !== null) {
        const key = nextFilterKey++;
        this.keys.set(listener, key);
        bridge.listen(this.name, key, filter);
      } else if (this.unfilteredCount() === 1) {
        bridge.listen(this.name);
      }
    }
    removeListener(listener: Fn) {
      if (!this.listeners.delete(listener)) return;
      const key = this.keys.get(listener);
      if (key !== undefined) {
        this.keys.delete(listener);
        bridge.unlisten(this.name, key);
      } else if (this.unfilteredCount() === 0) {
        bridge.unlisten(this.name);
      }
    }
  }

  const localHandlers = new Map<string, (args: unknown[]) => void>();

  bridge.onEvent((name, args, matched) => {
    localHandlers.get(name)?.(args);
    const keys = filterKeys.get(name);
    for (const listener of [...(events.get(name) ?? [])]) {
      const key = keys?.get(listener);
      if (matched && key !== undefined && !matched.includes(key)) continue;
      try {
        listener(...args);
      } catch (error) {
        console.error(error);
      }
    }
  });

  function namespace(
    name: string,
    definition: {
      methods?: readonly string[];
      events?: readonly string[];
      constants?: Record<string, unknown>;
      extra?: Record<string, unknown>;
      filterable?: boolean;
    },
    target = name,
  ): Record<string, unknown> {
    const existing = chrome[target];
    const api: Record<string, unknown> = existing && typeof existing === "object" ? existing : {};
    for (const m of definition.methods ?? []) api[m] = method(`${name}.${m}`);
    for (const e of definition.events ?? []) api[e] = new ExtensionEvent(`${name}.${e}`, definition.filterable);
    Object.assign(api, definition.constants ?? {}, definition.extra ?? {});
    if (api !== existing) {
      try {
        Object.defineProperty(chrome, target, { configurable: true, enumerable: true, writable: true, value: api });
      } catch {
        chrome[target] = api;
      }
    }
    return api;
  }

  const has = (permission: string) => declared.has(permission);

  namespace("tabs", {
    methods: spec.tabs.methods,
    events: spec.tabs.events,
    constants: { TAB_ID_NONE: -1, TAB_INDEX_NONE: -1, MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND: 2 },
  });

  namespace("windows", {
    methods: spec.windows.methods,
    events: spec.windows.events,
    constants: {
      WINDOW_ID_NONE: -1,
      WINDOW_ID_CURRENT: -2,
      WindowType: { NORMAL: "normal", POPUP: "popup", PANEL: "panel", APP: "app", DEVTOOLS: "devtools" },
      WindowState: {
        NORMAL: "normal",
        MINIMIZED: "minimized",
        MAXIMIZED: "maximized",
        FULLSCREEN: "fullscreen",
        LOCKED_FULLSCREEN: "locked-fullscreen",
      },
      CreateType: { NORMAL: "normal", POPUP: "popup", PANEL: "panel" },
    },
  });

  const setIcon = method("action.setIcon");
  const iconOverride = {
    setIcon(details: { imageData?: unknown; path?: unknown; tabId?: number }, callback?: Fn) {
      const encode = (image: unknown) => {
        const data = image as { width: number; height: number; data: Uint8ClampedArray };
        return { width: data.width, height: data.height, data: new Uint8Array(data.data.buffer.slice(0)) };
      };
      let imageData = details.imageData as unknown;
      if (imageData && typeof imageData === "object") {
        imageData =
          "data" in (imageData as object)
            ? encode(imageData)
            : Object.fromEntries(
                Object.entries(imageData as Record<string, unknown>).map(([size, image]) => [size, encode(image)]),
              );
      }
      // Chrome resolves icon paths against the calling script, not the extension root
      const absolute = (value: unknown) => (typeof value === "string" ? new URL(value, location.href).href : value);
      const path =
        details.path && typeof details.path === "object"
          ? Object.fromEntries(Object.entries(details.path as Record<string, unknown>).map(([size, p]) => [size, absolute(p)]))
          : absolute(details.path);
      return setIcon({ ...details, imageData, path }, ...(callback ? [callback] : []));
    },
  };
  if (manifest.action || manifest.manifest_version === 3) {
    namespace("action", { methods: spec.action.methods, events: spec.action.events, extra: iconOverride });
  }
  if (manifest.browser_action) {
    namespace(
      "action",
      { methods: spec.action.methods, events: spec.action.events, extra: iconOverride },
      "browserAction",
    );
  }
  if (manifest.page_action) {
    const pageAction = namespace(
      "action",
      { methods: spec.action.methods, events: spec.action.events, extra: iconOverride },
      "pageAction",
    );
    pageAction.show = method("action.enable");
    pageAction.hide = method("action.disable");
  }

  if (has("contextMenus") || has("menus")) {
    const clickHandlers = new Map<string | number, Fn>();
    let nextMenuId = 1;
    const create = method("contextMenus.create");
    const update = method("contextMenus.update");
    const remember = (itemId: string | number, onclick: unknown) => {
      if (typeof onclick !== "function") return;
      if (clickHandlers.size === 0) bridge.listen("contextMenus.onclick");
      clickHandlers.set(itemId, onclick as Fn);
    };
    const menus = namespace("contextMenus", {
      methods: spec.contextMenus.methods,
      events: ["onClicked"],
      constants: {
        ACTION_MENU_TOP_LEVEL_LIMIT: 6,
        ContextType: {
          ALL: "all",
          PAGE: "page",
          FRAME: "frame",
          SELECTION: "selection",
          LINK: "link",
          EDITABLE: "editable",
          IMAGE: "image",
          VIDEO: "video",
          AUDIO: "audio",
          LAUNCHER: "launcher",
          BROWSER_ACTION: "browser_action",
          PAGE_ACTION: "page_action",
          ACTION: "action",
        },
        ItemType: { NORMAL: "normal", CHECKBOX: "checkbox", RADIO: "radio", SEPARATOR: "separator" },
      },
      extra: {
        create(properties: Record<string, unknown>, callback?: Fn) {
          const { onclick, ...rest } = properties;
          const generated = rest.id === undefined ? nextMenuId++ : undefined;
          const itemId = (rest.id as string | undefined) ?? (generated as number);
          remember(itemId, onclick);
          const sent = { ...rest, generatedId: generated, onclick: typeof onclick === "function" ? true : undefined };
          create(sent, callback ?? (() => void chrome.runtime.lastError));
          return itemId;
        },
        update(itemId: string | number, properties: Record<string, unknown>, callback?: Fn) {
          const { onclick, ...rest } = properties;
          remember(itemId, onclick);
          return update(itemId, rest, ...(callback ? [callback] : []));
        },
      },
    });
    localHandlers.set("contextMenus.onclick", (args) => {
      const info = args[0] as { menuItemId: string | number };
      clickHandlers.get(info.menuItemId)?.(...args);
    });
    if (has("menus")) chrome.menus = menus;
  }

  if (manifest.commands)
    namespace("commands", {
      methods: spec.commands.methods,
      events: spec.commands.events,
    });

  namespace("permissions", {
    methods: spec.permissions.methods,
    events: spec.permissions.events,
  });

  if (has("cookies")) {
    namespace("cookies", {
      methods: spec.cookies.methods,
      events: spec.cookies.events,
      constants: {
        SameSiteStatus: { NO_RESTRICTION: "no_restriction", LAX: "lax", STRICT: "strict", UNSPECIFIED: "unspecified" },
        OnChangedCause: {
          EVICTED: "evicted",
          EXPIRED: "expired",
          EXPLICIT: "explicit",
          EXPIRED_OVERWRITE: "expired_overwrite",
          OVERWRITE: "overwrite",
        },
      },
    });
  }

  if (has("webNavigation")) {
    namespace("webNavigation", {
      methods: spec.webNavigation.methods,
      events: spec.webNavigation.events,
      filterable: true,
    });
  }

  if (has("notifications")) {
    namespace("notifications", {
      methods: spec.notifications.methods,
      events: spec.notifications.events,
      constants: {
        TemplateType: { BASIC: "basic", IMAGE: "image", LIST: "list", PROGRESS: "progress" },
        PermissionLevel: { GRANTED: "granted", DENIED: "denied" },
      },
    });
  }

  if (has("sidePanel")) {
    namespace("sidePanel", {
      methods: spec.sidePanel.methods,
      events: spec.sidePanel.events,
    });
  }

  // Without the permission Chrome only exposes the calls about the extension itself.
  namespace(
    "management",
    has("management")
      ? { methods: spec.management.methods, events: spec.management.events }
      : { methods: ["getSelf", "uninstallSelf", "getPermissionWarningsByManifest"] },
  );

  if (has("history")) {
    namespace("history", {
      methods: spec.history.methods,
      events: spec.history.events,
    });
  }

  if (has("downloads")) {
    namespace("downloads", {
      methods: spec.downloads.methods,
      events: spec.downloads.events,
    });
  }

  if (has("bookmarks")) {
    namespace("bookmarks", {
      methods: spec.bookmarks.methods,
      events: spec.bookmarks.events,
      constants: { MAX_WRITE_OPERATIONS_PER_HOUR: 1000000, MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE: 1000000 },
    });
  }

  if (has("sessions")) {
    namespace("sessions", {
      methods: spec.sessions.methods,
      events: spec.sessions.events,
      constants: { MAX_SESSION_RESULTS: 25 },
    });
  }

  if (has("search")) namespace("search", { methods: spec.search.methods });
  if (has("topSites")) namespace("topSites", { methods: spec.topSites.methods });

  if (has("identity")) {
    namespace("identity", {
      methods: spec.identity.methods,
      events: spec.identity.events,
      extra: {
        getRedirectURL(path = "") {
          return `https://${id}.chromiumapp.org/${String(path).replace(/^\//, "")}`;
        },
      },
    });
  }

  if (has("browsingData")) {
    namespace("browsingData", {
      methods: spec.browsingData.methods,
    });
  }

  if (has("debugger")) {
    namespace("debugger", {
      methods: spec.debugger.methods,
      events: spec.debugger.events,
      constants: { DetachReason: { TARGET_CLOSED: "target_closed", CANCELED_BY_USER: "canceled_by_user" } },
    });
  }

  if (has("tabGroups")) {
    namespace("tabGroups", {
      methods: spec.tabGroups.methods,
      events: spec.tabGroups.events,
      constants: {
        TAB_GROUP_ID_NONE: -1,
        Color: {
          GREY: "grey",
          BLUE: "blue",
          RED: "red",
          YELLOW: "yellow",
          GREEN: "green",
          PINK: "pink",
          PURPLE: "purple",
          CYAN: "cyan",
          ORANGE: "orange",
        },
      },
    });
  }

  namespace("extension", { methods: spec.extension.methods });

  // Electron rejects every managed storage read; Chrome without admin policies answers with nothing set
  const managed = (chrome.storage as Record<string, unknown> | undefined)?.managed as Record<string, unknown> | undefined;
  if (managed) {
    const answer = (value: unknown) =>
      function (...args: unknown[]) {
        const callback = typeof args[args.length - 1] === "function" ? (args.pop() as Fn) : null;
        if (!callback) return Promise.resolve(value);
        queueMicrotask(() => callback(value));
        return undefined;
      };
    managed.get = answer({});
    managed.getBytesInUse = answer(0);
  }

  const runtime = chrome.runtime;
  runtime.openOptionsPage = method("runtime.openOptionsPage");
  runtime.setUninstallURL = method("runtime.setUninstallURL");
  runtime.requestUpdateCheck = method("runtime.requestUpdateCheck");
  if (manifest.manifest_version === 3) runtime.getContexts = method("runtime.getContexts");
  // Electron's loader never fires these, so the main process does
  runtime.onInstalled = new ExtensionEvent("runtime.onInstalled");
  runtime.onStartup = new ExtensionEvent("runtime.onStartup");

  // Electron's sender.tab always says windowId 0, index 0, inactive; the main process keeps a correct copy here
  const senderTabs = new Map<number, Record<string, unknown>>();
  let watchingSenderTabs = false;
  const storeSenderTabs = (tabs: unknown) => {
    senderTabs.clear();
    for (const tab of tabs as Record<string, unknown>[]) senderTabs.set(tab.id as number, tab);
  };
  localHandlers.set("runtime.senderTabs", ([tabs]) => storeSenderTabs(tabs));
  const fixSender = (sender: Record<string, unknown> | undefined) => {
    const tab = sender?.tab as Record<string, unknown> | undefined;
    if (!tab) return;
    const known = senderTabs.get(tab.id as number);
    sender!.tab = known ? { ...known, url: tab.url ?? known.url, title: tab.title ?? known.title } : { ...tab, windowId: -2, groupId: -1 };
  };
  const wrapped = new WeakMap<Fn, Fn>();
  type NativeEvent = { addListener: Fn; removeListener: Fn; hasListener: Fn };
  const fixSenders = (value: unknown, wrap: (listener: Fn) => Fn) => {
    const event = value as NativeEvent | undefined;
    if (!event?.addListener) return;
    const { addListener, removeListener, hasListener } = event;
    event.addListener = function (this: unknown, listener: Fn, ...rest: unknown[]) {
      if (!watchingSenderTabs) {
        watchingSenderTabs = true;
        call("runtime.watchSenderTabs", []).then(storeSenderTabs, () => {});
      }
      let wrapper = wrapped.get(listener);
      if (!wrapper && typeof listener === "function") wrapped.set(listener, (wrapper = wrap(listener)));
      return addListener.call(this, wrapper ?? listener, ...rest);
    } as Fn;
    event.removeListener = function (this: unknown, listener: Fn) {
      return removeListener.call(this, wrapped.get(listener) ?? listener);
    } as Fn;
    event.hasListener = function (this: unknown, listener: Fn) {
      return hasListener.call(this, wrapped.get(listener) ?? listener);
    } as Fn;
  };
  const fixMessageSender = (listener: Fn) =>
    function (this: unknown, message: unknown, sender: unknown, sendResponse: unknown) {
      fixSender(sender as Record<string, unknown> | undefined);
      return listener.call(this, message, sender, sendResponse);
    } as Fn;
  const fixPortSender = (listener: Fn) =>
    function (this: unknown, port: unknown) {
      fixSender((port as { sender?: Record<string, unknown> } | undefined)?.sender);
      return listener.call(this, port);
    } as Fn;
  fixSenders(runtime.onMessage, fixMessageSender);
  fixSenders(runtime.onMessageExternal, fixMessageSender);
  fixSenders(runtime.onConnect, fixPortSender);
  fixSenders(runtime.onConnectExternal, fixPortSender);

  if (has("nativeMessaging")) {
    runtime.sendNativeMessage = method("runtime.sendNativeMessage");
    const ports = new Map<number, { port: Record<string, unknown>; onMessage: LocalEvent; onDisconnect: LocalEvent }>();
    const disconnected = (portId: number, error: unknown) => {
      const entry = ports.get(portId);
      if (!entry) return;
      ports.delete(portId);
      const run = () => entry.onDisconnect.dispatch(entry.port);
      if (error) withLastError(new Error(String(error)), run);
      else run();
    };
    localHandlers.set("runtime.nativeMessage", ([portId, message]) => {
      const entry = ports.get(portId as number);
      entry?.onMessage.dispatch(message, entry.port);
    });
    localHandlers.set("runtime.nativeDisconnect", ([portId, error]) => disconnected(portId as number, error));
    runtime.connectNative = (application: string) => {
      const portId = Math.floor(Math.random() * 2 ** 31);
      const onMessage = new LocalEvent();
      const onDisconnect = new LocalEvent();
      const port: Record<string, unknown> = {
        name: "",
        onMessage,
        onDisconnect,
        postMessage(message: unknown) {
          if (!ports.has(portId)) throw new Error("Attempting to use a disconnected port object");
          void call("runtime.nativePost", [portId, message]).catch(() => {});
        },
        disconnect() {
          if (!ports.delete(portId)) return;
          void call("runtime.nativeDisconnect", [portId]).catch(() => {});
        },
      };
      ports.set(portId, { port, onMessage, onDisconnect });
      call("runtime.nativeConnect", [portId, application]).catch((error: Error) => disconnected(portId, error.message));
      return port;
    };
  }

  // Chromium also exposes the same APIs as `browser`, a separate object
  const browserNamespace = (globalThis as unknown as { browser?: Record<string, unknown> }).browser;
  if (browserNamespace && browserNamespace !== (chrome as unknown)) {
    for (const key of Object.keys(chrome)) {
      try {
        Object.defineProperty(browserNamespace, key, { configurable: true, enumerable: true, writable: true, value: chrome[key] });
      } catch {}
    }
  }

  if (isWorker) return true;
  try {
    Object.defineProperty(window, "close", {
      configurable: true,
      value: () => void call("windows.closeSelf", []).catch(() => {}),
    });
  } catch {}
  return true;
}
