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
  GRANTED_CHANNEL,
  LISTEN_CHANNEL,
  READY_CHANNEL,
  UNLISTEN_CHANNEL,
  VIEW_INFO_CHANNEL,
  channelFor,
} from "./protocol";
import type { ApiSpec, ViewInfo } from "./protocol";
import { API_SCHEMAS } from "./api-schemas";
import type { ApiSchemas, ArgSpec } from "./validate";

type Listener = (name: string, args: unknown[], matched: number[] | undefined) => void;

interface BridgeShape {
  invoke(method: string, args: unknown[]): Promise<unknown>;
  listen(event: string, key?: number, filter?: unknown): void;
  unlisten(event: string, key?: number): void;
  onEvent(listener: Listener): void;
  ready(): void;
  viewInfo(): ViewInfo | null;
  grantedPermissions(): string[] | null;
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
  viewInfo() {
    return (ipcRenderer.sendSync(VIEW_INFO_CHANNEL) as ViewInfo | null) ?? null;
  },
  grantedPermissions() {
    try {
      return (ipcRenderer.sendSync(GRANTED_CHANNEL) as string[] | null) ?? null;
    } catch {
      return null;
    }
  },
};

// Offscreen documents run without context isolation, and like in Chrome they
// only get the chrome.runtime that Chromium already provides.
if (process.contextIsolated) {
  contextBridge.executeInMainWorld({
    func: installChromeApis,
    args: [bridge, process.type === "service-worker", API_SPEC, API_SCHEMAS],
  });
}

// Serialized into the page's own JavaScript world, so it can't use anything
// from the surrounding module.
export function installChromeApis(bridge: BridgeShape, isWorker: boolean, spec: ApiSpec, schemas: ApiSchemas): boolean {
  type Fn = (...args: unknown[]) => unknown;
  if (globalThis.location?.protocol !== "chrome-extension:") return false;
  const g = globalThis as unknown as { chrome: Record<string, Record<string, unknown>> };
  const chrome = g.chrome;
  if (!chrome || !chrome.runtime) return false;
  // runs once the extension's own top-level script has finished
  setTimeout(() => bridge.ready(), 0);
  const manifest = (chrome.runtime.getManifest as () => Record<string, unknown>)();
  const id = chrome.runtime.id as string;
  // Like Chrome, a namespace only exists while its permission is granted, so
  // optional permissions show up after permissions.request and go after remove.
  const granted = new Set<string>(bridge.grantedPermissions() ?? ((manifest.permissions as string[] | undefined) ?? []));

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

  // Chrome checks each call against the API's schema before sending it and
  // throws right away (extensions/renderer/bindings/api_signature.cc and
  // argument_spec.cc), with these exact messages.
  type Spec = ArgSpec;
  const valueType = (value: unknown): string => {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value === "number") {
      const int32 = Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 && !Object.is(value, -0);
      return int32 ? "integer" : "number";
    }
    if (typeof value === "boolean") return "boolean";
    if (typeof value === "string") return "string";
    if (Array.isArray(value)) return "array";
    if (typeof value === "function") return "function";
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return "binary";
    if (typeof value === "object") return "object";
    return "other";
  };
  const typeName = (spec: Spec): string => {
    if (spec.$ref) return spec.$ref;
    if (spec.choices) return `[${spec.choices.map(typeName).join("|")}]`;
    if (spec.type === "object") return spec.isInstanceOf ?? "object";
    return spec.type ?? "any";
  };
  const referenced = (spec: Spec): Spec => (spec.$ref ? (schemas.types[spec.$ref] ?? { type: "any" }) : spec);
  const correctType = (spec: Spec, value: unknown): boolean => {
    if (spec.$ref) return correctType(referenced(spec), value);
    if (spec.choices) return spec.choices.some((choice) => correctType(choice, value));
    switch (spec.type) {
      case "integer":
        return valueType(value) === "integer" || value === 0;
      case "number":
        return typeof value === "number";
      case "boolean":
        return typeof value === "boolean";
      case "string":
        return typeof value === "string";
      case "object":
        return typeof value === "object" && value !== null && !Array.isArray(value);
      case "array":
        return Array.isArray(value);
      case "binary":
        return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
      case "function":
        return typeof value === "function";
      default:
        return true;
    }
  };
  const bounds = (spec: Spec, value: number): string | null => {
    if (spec.minimum !== undefined && value < spec.minimum) return `Value must be at least ${spec.minimum}.`;
    if (spec.maximum !== undefined && value > spec.maximum) return `Value must be at most ${spec.maximum}.`;
    return null;
  };
  const instanceOf = (value: object, name: string): boolean => {
    for (let at: object | null = value; at !== null && typeof at === "object"; at = Object.getPrototypeOf(at)) {
      if ((at as { constructor?: { name?: string } }).constructor?.name === name) return true;
    }
    return false;
  };
  // Chrome's error for `value`, or null when it fits `spec`.
  const check = (spec: Spec, value: unknown): string | null => {
    if (!correctType(spec, value)) return `Invalid type: expected ${typeName(spec)}, found ${valueType(value)}.`;
    if (spec.$ref) return check(referenced(spec), value);
    if (spec.choices) return spec.choices.some((choice) => check(choice, value) === null) ? null : "Value did not match any choice.";
    switch (spec.type) {
      case "integer":
        return bounds(spec, value as number);
      case "number":
        return Number.isFinite(value) ? bounds(spec, value as number) : "Value must not be NaN or Infinity.";
      case "string": {
        const text = value as string;
        if (spec.minLength !== undefined && text.length < spec.minLength) {
          return `String must have at least ${spec.minLength} characters; found ${text.length}.`;
        }
        if (spec.maxLength !== undefined && text.length > spec.maxLength) {
          return `String must have at most ${spec.maxLength} characters; found ${text.length}.`;
        }
        if (spec.enum && !spec.enum.includes(text)) return `Value must be one of ${[...spec.enum].sort().join(", ")}.`;
        return null;
      }
      case "array": {
        const list = value as unknown[];
        const min = spec.minItems ?? spec.minLength;
        const max = spec.maxItems ?? spec.maxLength;
        if (min !== undefined && list.length < min) return `Array must have at least ${min} items; found ${list.length}.`;
        if (max !== undefined && list.length > max) return `Array must have at most ${max} items; found ${list.length}.`;
        for (let i = 0; i < list.length; i++) {
          const error = check(spec.items ?? { type: "any" }, list[i]);
          if (error) return `Error at index ${i}: ${error}`;
        }
        return null;
      }
      case "object": {
        const object = value as Record<string, unknown>;
        const seen = new Set<string>();
        for (const key of Object.keys(object)) {
          let property = spec.properties && Object.hasOwn(spec.properties, key) ? spec.properties[key] : undefined;
          let lenient = false;
          if (property) {
            seen.add(key);
          } else if (spec.additionalProperties) {
            property = { ...spec.additionalProperties, optional: true };
            lenient = property.type === "any";
          } else if (spec.ignoreAdditionalProperties) {
            continue;
          } else {
            return `Unexpected property: '${key}'.`;
          }
          const item = object[key];
          if (item === undefined || item === null) {
            if (!property.optional) return `Missing required property '${key}'.`;
            continue;
          }
          const error = check(property, item);
          if (error && !lenient) return `Error at property '${key}': ${error}`;
        }
        for (const key of Object.keys(spec.properties ?? {}).sort()) {
          if (!spec.properties![key].optional && !seen.has(key)) return `Missing required property '${key}'.`;
        }
        if (spec.isInstanceOf && !instanceOf(object, spec.isInstanceOf)) return `Value must be an instance of ${spec.isInstanceOf}.`;
        return null;
      }
      default:
        return null;
    }
  };
  function validate(name: string, args: unknown[]) {
    const params = schemas.functions[name];
    if (!params) return;
    const fail = (error: string): never => {
      const signature = params.map((p) => `${p.optional ? "optional " : ""}${typeName(p)} ${p.name}`).join(", ");
      throw new TypeError(`Error in invocation of ${name}(${signature}): ${error}`);
    };
    if (args.length > params.length) fail("No matching signature.");
    // The argument each parameter got, or -1 when it was left out.
    const argumentFor: number[] = [];
    // Optional parameters may be left out anywhere, so try every way the
    // arguments could line up with the parameters by type.
    const match = (a: number, p: number): boolean => {
      if (args.length - a > params.length - p) return false;
      if (p === params.length) return true;
      if (a < args.length) {
        const value = args[a];
        const omitted = params[p].optional === true && (value === null || value === undefined);
        if (omitted || correctType(params[p], value)) {
          argumentFor[p] = omitted ? -1 : a;
          if (match(a + 1, p + 1)) return true;
        }
      }
      if (!params[p].optional) return false;
      argumentFor[p] = -1;
      return match(a, p + 1);
    };
    if (!match(0, 0)) fail("No matching signature.");
    params.forEach((param, p) => {
      if (argumentFor[p] < 0) return;
      const error = check(param, args[argumentFor[p]]);
      if (error) fail(`Error at parameter '${param.name}': ${error}`);
    });
  }

  function method(name: string, validated = true): Fn {
    return function (this: unknown, ...args: unknown[]) {
      if (validated) validate(name, args);
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
    // Like Chrome, anything but a function is silently ignored.
    addListener(listener: Fn) {
      if (typeof listener !== "function") return;
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
      if (typeof listener !== "function") return;
      if (filter !== undefined && !this.filterable) throw new TypeError("This event does not support filters");
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
  // Like Chrome's argument massagers: hand listeners extra arguments and act on what they return.
  const massagers = new Map<string, (args: unknown[], dispatch: (args: unknown[]) => unknown[]) => void>();

  bridge.onEvent((name, args, matched) => {
    localHandlers.get(name)?.(args);
    const keys = filterKeys.get(name);
    const dispatch = (listenerArgs: unknown[]) => {
      const results: unknown[] = [];
      for (const listener of [...(events.get(name) ?? [])]) {
        const key = keys?.get(listener);
        if (matched && key !== undefined && !matched.includes(key)) continue;
        try {
          results.push(listener(...listenerArgs));
        } catch (error) {
          console.error(error);
        }
      }
      return results;
    };
    const massager = massagers.get(name);
    if (massager) massager(args, dispatch);
    else dispatch(args);
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

  const has = (permission: string) => granted.has(permission);
  const gatedApis: { name: string; allowed: () => boolean; install: () => void }[] = [];
  const installedApis = new Set<string>();
  const gated = (name: string, allowed: () => boolean, install: () => void) => gatedApis.push({ name, allowed, install });
  const browserNamespace = (globalThis as unknown as { browser?: Record<string, unknown> }).browser;
  const applyGrants = () => {
    for (const { name, allowed, install } of gatedApis) {
      if (allowed()) {
        if (installedApis.has(name)) continue;
        install();
        installedApis.add(name);
      } else if (installedApis.delete(name)) {
        for (const key of name === "contextMenus" ? ["contextMenus", "menus"] : [name]) {
          delete chrome[key];
          if (browserNamespace && browserNamespace !== (chrome as unknown)) delete browserNamespace[key];
        }
      }
    }
  };

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

  const setIcon = method("action.setIcon", false);
  const iconOverride = {
    setIcon(details: { imageData?: unknown; path?: unknown; tabId?: number }, callback?: Fn) {
      validate("action.setIcon", [...arguments]);
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
  if (manifest.action) {
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

  gated("contextMenus", () => has("contextMenus") || has("menus"), () => {
    const clickHandlers = new Map<string | number, Fn>();
    let nextMenuId = 1;
    const create = method("contextMenus.create", false);
    const update = method("contextMenus.update", false);
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
          validate("contextMenus.create", [...arguments]);
          const { onclick, ...rest } = properties;
          const generated = rest.id === undefined ? nextMenuId++ : undefined;
          const itemId = (rest.id as string | undefined) ?? (generated as number);
          remember(itemId, onclick);
          const sent = { ...rest, generatedId: generated, onclick: typeof onclick === "function" ? true : undefined };
          create(sent, callback ?? (() => void chrome.runtime.lastError));
          return itemId;
        },
        update(itemId: string | number, properties: Record<string, unknown>, callback?: Fn) {
          validate("contextMenus.update", [...arguments]);
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
  });

  if (manifest.commands)
    namespace("commands", {
      methods: spec.commands.methods,
      events: spec.commands.events,
    });

  namespace("permissions", {
    methods: spec.permissions.methods,
    events: spec.permissions.events,
  });

  gated("cookies", () => has("cookies"), () => {
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
  });

  gated("webNavigation", () => has("webNavigation"), () => {
    namespace("webNavigation", {
      methods: spec.webNavigation.methods,
      events: spec.webNavigation.events,
      filterable: true,
    });
  });

  gated("notifications", () => has("notifications"), () => {
    namespace("notifications", {
      methods: spec.notifications.methods,
      events: spec.notifications.events,
      constants: {
        TemplateType: { BASIC: "basic", IMAGE: "image", LIST: "list", PROGRESS: "progress" },
        PermissionLevel: { GRANTED: "granted", DENIED: "denied" },
      },
    });
  });

  gated("sidePanel", () => has("sidePanel"), () => {
    namespace("sidePanel", {
      methods: spec.sidePanel.methods,
      events: spec.sidePanel.events,
    });
  });

  // Without the permission Chrome only exposes the calls about the extension itself.
  namespace(
    "management",
    has("management")
      ? { methods: spec.management.methods, events: spec.management.events }
      : { methods: ["getSelf", "uninstallSelf", "getPermissionWarningsByManifest"] },
  );

  gated("history", () => has("history"), () => {
    namespace("history", {
      methods: spec.history.methods,
      events: spec.history.events,
    });
  });

  gated("downloads", () => has("downloads"), () => {
    namespace("downloads", {
      methods: spec.downloads.methods,
      events: spec.downloads.events,
    });
    // Chrome's downloads_custom_bindings.js: a listener answers through suggest(),
    // later if it returned true, otherwise right after it returns.
    massagers.set("downloads.onDeterminingFilename", (args, dispatch) => {
      const downloadItem = args[0] as { id: number };
      const downloadId = downloadItem.id;
      let suggestable = true;
      const isValidResult = (result: unknown) => {
        if (result === undefined) return false;
        const value = result as { filename?: unknown; conflictAction?: unknown };
        if (typeof result !== "object" || result === null) {
          console.error(
            `Error: Invocation of form suggest(${typeof result}) doesn't match definition suggest({filename: string, conflictAction: string})`,
          );
          return false;
        }
        if (typeof value.filename !== "string" || value.filename.length === 0) {
          console.error('Error: "filename" parameter to suggest() must be a non-empty string');
          return false;
        }
        if (![undefined, "uniquify", "overwrite", "prompt"].includes(value.conflictAction as string | undefined)) {
          console.error('Error: "conflictAction" parameter to suggest() must be one of undefined, "uniquify", "overwrite", "prompt"');
          return false;
        }
        return true;
      };
      const suggest = (result?: unknown) => {
        if (!suggestable) {
          console.error("suggestCallback may not be called more than once.");
          return;
        }
        suggestable = false;
        const value = result as { filename: string; conflictAction?: string };
        const sent = isValidResult(result) ? [downloadId, value.filename, value.conflictAction || ""] : [downloadId, "", ""];
        call("downloadsInternal.determineFilename", sent).catch((error: Error) =>
          console.error(`Unchecked runtime.lastError: ${error.message}`),
        );
      };
      const results = dispatch([downloadItem, suggest]);
      if (suggestable && results[0] !== true) suggest();
    });
  });

  gated("bookmarks", () => has("bookmarks"), () => {
    namespace("bookmarks", {
      methods: spec.bookmarks.methods,
      events: spec.bookmarks.events,
      constants: { ROOT_NODE_ID: "0", MAX_WRITE_OPERATIONS_PER_HOUR: 1000000, MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE: 1000000 },
    });
  });

  gated("sessions", () => has("sessions"), () => {
    namespace("sessions", {
      methods: spec.sessions.methods,
      events: spec.sessions.events,
      constants: { MAX_SESSION_RESULTS: 25 },
    });
  });

  gated("search", () => has("search"), () => void namespace("search", { methods: spec.search.methods }));
  gated("topSites", () => has("topSites"), () => void namespace("topSites", { methods: spec.topSites.methods }));

  gated("identity", () => has("identity"), () => {
    namespace("identity", {
      methods: spec.identity.methods,
      events: spec.identity.events,
      extra: {
        getRedirectURL(path = "") {
          return `https://${id}.chromiumapp.org/${String(path).replace(/^\//, "")}`;
        },
      },
    });
  });

  gated("browsingData", () => has("browsingData"), () => {
    namespace("browsingData", {
      methods: spec.browsingData.methods,
    });
  });

  gated("debugger", () => has("debugger"), () => {
    namespace("debugger", {
      methods: spec.debugger.methods,
      events: spec.debugger.events,
      constants: { DetachReason: { TARGET_CLOSED: "target_closed", CANCELED_BY_USER: "canceled_by_user" } },
    });
  });

  gated("tabGroups", () => has("tabGroups"), () => {
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
  });

  const extensionApi = namespace("extension", {
    methods: ["isAllowedFileSchemeAccess", "isAllowedIncognitoAccess"],
    constants: { ViewType: { TAB: "tab", POPUP: "popup" } },
    extra: {
      setUpdateUrlData(data: unknown) {
        validate("extension.setUpdateUrlData", [...arguments]);
        void call("extension.setUpdateUrlData", [data]).catch(() => {});
      },
    },
  });
  if (!isWorker) {
    // Only this page and the extension frames inside it are reachable from
    // here; Chrome also returns the extension's other pages in this process.
    extensionApi.getViews = (fetchProperties?: { type?: string; windowId?: number; tabId?: number }) => {
      const wanted = fetchProperties ?? {};
      const view = bridge.viewInfo();
      if (!view) return [];
      const windowId = wanted.windowId === -2 ? view.windowId : wanted.windowId ?? -1;
      if (wanted.type !== undefined && wanted.type !== view.type) return [];
      if (windowId !== -1 && windowId !== view.windowId) return [];
      if ((wanted.tabId ?? -1) !== -1 && wanted.tabId !== view.tabId) return [];
      const ours = (target: Window) => {
        try {
          return target.location.origin === location.origin;
        } catch {
          return false;
        }
      };
      const views: Window[] = [];
      const visit = (target: Window) => {
        if (!ours(target)) return;
        views.push(target);
        for (let i = 0; i < target.frames.length; i++) visit(target.frames[i]);
      };
      let root: Window = window;
      while (root.parent !== root && ours(root.parent)) root = root.parent;
      visit(root);
      return views;
    };
  }

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
    const readOnly = function (...args: unknown[]) {
      const error = new Error("This is a read-only store.");
      const callback = typeof args[args.length - 1] === "function" ? (args.pop() as Fn) : null;
      if (!callback) return Promise.reject(error);
      queueMicrotask(() => withLastError(error, () => callback()));
      return undefined;
    };
    managed.get = answer({});
    managed.getBytesInUse = answer(0);
    managed.set = readOnly;
    managed.remove = readOnly;
    managed.clear = readOnly;
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
  const notTabs = new Set<number>();
  let watchingSenderTabs = false;
  const storeSenderTabs = (snapshot: unknown) => {
    const { tabs, notTabs: others } = snapshot as { tabs: Record<string, unknown>[]; notTabs: number[] };
    senderTabs.clear();
    for (const tab of tabs) senderTabs.set(tab.id as number, tab);
    notTabs.clear();
    for (const id of others) notTabs.add(id);
  };
  localHandlers.set("runtime.senderTabs", ([snapshot]) => storeSenderTabs(snapshot));
  const fixSender = (sender: Record<string, unknown> | undefined) => {
    const tab = sender?.tab as Record<string, unknown> | undefined;
    if (!tab) return;
    // Chrome only describes the tab, frame and document of senders that are tabs.
    if (notTabs.has(tab.id as number)) {
      for (const key of ["tab", "frameId", "documentId", "documentLifecycle"]) delete sender![key];
      return;
    }
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
  const mirrorBrowser = () => {
    if (!browserNamespace || browserNamespace === (chrome as unknown)) return;
    for (const key of Object.keys(chrome)) {
      try {
        Object.defineProperty(browserNamespace, key, { configurable: true, enumerable: true, writable: true, value: chrome[key] });
      } catch {}
    }
  };
  applyGrants();
  mirrorBrowser();
  localHandlers.set("runtime.permissionsChanged", ([apis]) => {
    granted.clear();
    for (const permission of apis as string[]) granted.add(permission);
    applyGrants();
    mirrorBrowser();
  });
  bridge.listen("runtime.permissionsChanged");

  if (isWorker) return true;
  try {
    Object.defineProperty(window, "close", {
      configurable: true,
      value: () => void call("windows.closeSelf", []).catch(() => {}),
    });
  } catch {}
  return true;
}
