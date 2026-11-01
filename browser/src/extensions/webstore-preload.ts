// Runs in every frame but only acts in the Chrome Web Store's top frame, where
// it adds the chrome.webstorePrivate and chrome.management APIs the store uses
// for "Add to Chrome" and "Remove from Chrome". The main process decides
// everything and shows our own install prompt. Self-contained like preload.ts.
import { contextBridge, ipcRenderer } from "electron";

const WEBSTORE_ORIGIN = "https://chromewebstore.google.com";

// From Chrome 142.0.7430.0 on, the store asks its server whether the browser is
// really Chrome, which only Google's own build passes. Below that it checks the
// user agent, which ours passes, so the store is told this version.
const STORE_CHROME_VERSION = "142.0.7429.0";

type EventListener = (name: string, args: unknown[]) => void;

interface WebStoreBridge {
  call(method: string, args: unknown[]): Promise<unknown>;
  onEvent(listener: EventListener): void;
}

const METHODS = new Set([
  "begin-install",
  "complete-install",
  "install",
  "extension-status",
  "management-get-all",
  "management-get",
  "management-set-enabled",
  "management-uninstall",
]);

const ERROR_PREFIX = /^Error invoking remote method '[^']*': (?:Error: )?/;

if (location.origin === WEBSTORE_ORIGIN && window.top === window) {
  const bridge: WebStoreBridge = {
    call(method, args) {
      if (!METHODS.has(method)) return Promise.reject(new Error(`unknown method ${method}`));
      return ipcRenderer.invoke(`tb-webstore:${method}`, ...args).catch((error: Error) => {
        throw new Error(String(error?.message ?? error).replace(ERROR_PREFIX, ""));
      });
    },
    onEvent(listener) {
      ipcRenderer.on("tb-webstore:event", (_event, name: string, args: unknown[]) => listener(name, args));
    },
  };
  contextBridge.executeInMainWorld({ func: installWebStoreApis, args: [bridge, STORE_CHROME_VERSION] });
  rebrandStoreUi();
}

const BRAND = "terminal-browser";
// Only the store's own controls and notices, never listing text like descriptions
const STORE_UI = 'button, [role="button"], [role="menuitem"], [role="alert"], [role="status"], [role="dialog"], [aria-live]';
const CHROME_WORD = /\b(?:Google\s)?Chrome\b(?!\sWeb\sStore)/g;

function rebrand(value: string): string {
  return value.replace(CHROME_WORD, BRAND);
}

function rebrandText(node: Text) {
  const value = node.nodeValue;
  if (!value || !value.includes("Chrome") || !node.parentElement?.closest(STORE_UI)) return;
  const next = rebrand(value);
  if (next !== value) node.nodeValue = next;
}

function rebrandLabel(element: Element) {
  const label = element.getAttribute("aria-label");
  if (label?.includes("Chrome") && element.matches(STORE_UI)) element.setAttribute("aria-label", rebrand(label));
}

function rebrandTree(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) {
    rebrandText(root as Text);
    return;
  }
  if (!(root instanceof Element) && !(root instanceof Document)) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) rebrandText(node as Text);
  if (root instanceof Element) rebrandLabel(root);
  root.querySelectorAll?.("[aria-label*='Chrome']").forEach(rebrandLabel);
}

// The store re-renders with React and navigates between listings without
// reloading, so every text change is checked again as it lands.
function rebrandStoreUi() {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "characterData") rebrandText(mutation.target as Text);
      else if (mutation.type === "attributes") rebrandLabel(mutation.target as Element);
      else mutation.addedNodes.forEach(rebrandTree);
    }
  });
  const start = () => {
    observer.observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label"],
    });
    rebrandTree(document);
  };
  if (document.documentElement) start();
  else document.addEventListener("readystatechange", start, { once: true });
}

// Serialized into the store page's own JavaScript world, so it can't use
// anything from the surrounding module.
function installWebStoreApis(bridge: WebStoreBridge, chromeVersion: string): boolean {
  type Callback = (...args: unknown[]) => void;
  if (location.origin !== "https://chromewebstore.google.com" || window.top !== window) return false;
  const g = globalThis as unknown as { chrome?: Record<string, unknown> };
  const chrome = (g.chrome ??= {}) as Record<string, unknown>;
  const runtime = ((chrome.runtime as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
  chrome.runtime = runtime;

  let lastError: { message: string } | undefined;
  try {
    Object.defineProperty(runtime, "lastError", { configurable: true, enumerable: true, get: () => lastError });
  } catch {}
  const extension = {};
  Object.defineProperty(extension, "lastError", { enumerable: true, get: () => lastError });
  Object.defineProperty(chrome, "extension", { value: extension, enumerable: true, configurable: false, writable: false });

  const withLastError = (message: string | undefined, run: () => void) => {
    lastError = message === undefined ? undefined : { message };
    try {
      run();
    } finally {
      lastError = undefined;
    }
  };

  const callbackOf = (args: unknown[]): Callback | null => {
    const last = args[args.length - 1];
    return typeof last === "function" ? (last as Callback) : null;
  };

  // Answers both callback and promise callers, like Chrome's bindings.
  const respond = <T>(args: unknown[], work: Promise<T>): Promise<T> | undefined => {
    const callback = callbackOf(args);
    if (!callback) return work;
    work.then(
      (value) => withLastError(undefined, () => (value === undefined ? callback() : callback(value))),
      (error: Error) => withLastError(String(error?.message ?? error), () => callback()),
    );
    return undefined;
  };

  const local = <T>(value: T) => (...args: unknown[]) => respond(args, Promise.resolve(value));

  const Result = {
    EMPTY_STRING: "",
    SUCCESS: "success",
    USER_GESTURE_REQUIRED: "user_gesture_required",
    UNKNOWN_ERROR: "unknown_error",
    FEATURE_DISABLED: "feature_disabled",
    UNSUPPORTED_EXTENSION_TYPE: "unsupported_extension_type",
    MISSING_DEPENDENCIES: "missing_dependencies",
    INSTALL_ERROR: "install_error",
    USER_CANCELLED: "user_cancelled",
    INVALID_ID: "invalid_id",
    BLACKLISTED: "blacklisted",
    BLOCKED_BY_POLICY: "blocked_by_policy",
    INSTALL_IN_PROGRESS: "install_in_progress",
    LAUNCH_IN_PROGRESS: "launch_in_progress",
    MANIFEST_ERROR: "manifest_error",
    ICON_ERROR: "icon_error",
    INVALID_ICON_URL: "invalid_icon_url",
    ALREADY_INSTALLED: "already_installed",
    BLOCKED_FOR_CHILD_ACCOUNT: "blocked_for_child_account",
  };

  // beginInstallWithManifest3 reports failures as a result code plus lastError.
  const beginInstall = (...args: unknown[]) => {
    const callback = callbackOf(args);
    const work = bridge.call("begin-install", [args[0]]) as Promise<{ result: string; error?: string }>;
    const settled = work.catch((error: Error) => ({ result: "unknown_error", error: String(error?.message ?? error) }));
    if (!callback) {
      return settled.then(({ result, error }) => {
        if (error) throw new Error(error);
        return result;
      });
    }
    settled.then(({ result, error }) => withLastError(error, () => callback(result)));
    return undefined;
  };

  // Chromium re-adds its own chrome.management when an extension loads, so ours
  // can't be replaced.
  const define = (name: string, value: Record<string, unknown>) =>
    Object.defineProperty(chrome, name, { value, enumerable: true, configurable: false, writable: false });

  define("webstorePrivate", {
    Result,
    WebGlStatus: { WEBGL_ALLOWED: "webgl_allowed", WEBGL_BLOCKED: "webgl_blocked" },
    MV2DeprecationStatus: { INACTIVE: "inactive", WARNING: "warning", SOFT_DISABLE: "soft_disable", HARD_DISABLE: "hard_disable" },
    ExtensionInstallStatus: {
      CAN_REQUEST: "can_request",
      REQUEST_PENDING: "request_pending",
      BLOCKED_BY_POLICY: "blocked_by_policy",
      INSTALLABLE: "installable",
      ENABLED: "enabled",
      DISABLED: "disabled",
      TERMINATED: "terminated",
      BLACKLISTED: "blacklisted",
      CUSTODIAN_APPROVAL_REQUIRED: "custodian_approval_required",
      CUSTODIAN_APPROVAL_REQUIRED_FOR_INSTALLATION: "custodian_approval_required_for_installation",
      FORCE_INSTALLED: "force_installed",
      DEPRECATED_MANIFEST_VERSION: "deprecated_manifest_version",
      CORRUPTED: "corrupted",
    },
    beginInstallWithManifest3: beginInstall,
    completeInstall: (...args: unknown[]) => respond(args, bridge.call("complete-install", [args[0]])),
    install: (...args: unknown[]) => respond(args, bridge.call("install", [args[0]])),
    getExtensionStatus: (...args: unknown[]) =>
      respond(args, bridge.call("extension-status", [args[0], typeof args[1] === "string" ? args[1] : ""])),
    getFullChromeVersion: local({ version_number: chromeVersion }),
    getBrowserLogin: local({ login: "" }),
    getStoreLogin: local(""),
    setStoreLogin: local(undefined),
    getWebGLStatus: local("webgl_allowed"),
    getIsLauncherEnabled: local(false),
    enableAppLauncher: local(undefined),
    isInIncognitoMode: local(false),
    isPendingCustodianApproval: local(false),
    getReferrerChain: local(""),
    getMV2DeprecationStatus: local("hard_disable"),
    shouldShowEnterprisePromotionBanner: local("PROMOTION_TYPE_UNSPECIFIED"),
    logEnterprisePromoShown: local(undefined),
    onEnterprisePromoClick: local(undefined),
  });

  const listeners = new Map<string, Set<Callback>>();
  const event = (name: string) => {
    const set = new Set<Callback>();
    listeners.set(name, set);
    return {
      addListener: (listener: Callback) => void set.add(listener),
      removeListener: (listener: Callback) => void set.delete(listener),
      hasListener: (listener: Callback) => set.has(listener),
      hasListeners: () => set.size > 0,
    };
  };
  bridge.onEvent((name, args) => {
    for (const listener of [...(listeners.get(name) ?? [])]) {
      try {
        listener(...args);
      } catch (error) {
        setTimeout(() => {
          throw error;
        });
      }
    }
  });

  define("management", {
    ExtensionType: { EXTENSION: "extension", HOSTED_APP: "hosted_app", PACKAGED_APP: "packaged_app", LEGACY_PACKAGED_APP: "legacy_packaged_app", THEME: "theme", LOGIN_SCREEN_EXTENSION: "login_screen_extension" },
    ExtensionInstallType: { ADMIN: "admin", DEVELOPMENT: "development", NORMAL: "normal", SIDELOAD: "sideload", OTHER: "other" },
    ExtensionDisabledReason: { UNKNOWN: "unknown", PERMISSIONS_INCREASE: "permissions_increase" },
    LaunchType: { OPEN_AS_REGULAR_TAB: "OPEN_AS_REGULAR_TAB", OPEN_AS_PINNED_TAB: "OPEN_AS_PINNED_TAB", OPEN_AS_WINDOW: "OPEN_AS_WINDOW", OPEN_FULL_SCREEN: "OPEN_FULL_SCREEN" },
    getAll: (...args: unknown[]) => respond(args, bridge.call("management-get-all", [])),
    get: (...args: unknown[]) => respond(args, bridge.call("management-get", [args[0]])),
    setEnabled: (...args: unknown[]) => respond(args, bridge.call("management-set-enabled", [args[0], args[1] === true])),
    uninstall: (...args: unknown[]) => respond(args, bridge.call("management-uninstall", [args[0]])),
    onInstalled: event("management.onInstalled"),
    onUninstalled: event("management.onUninstalled"),
    onEnabled: event("management.onEnabled"),
    onDisabled: event("management.onDisabled"),
  });
  return true;
}
