export interface ApiNamespace {
  methods: readonly string[];
  events: readonly string[];
}

export const API_SPEC = {
  extension: {
    methods: ["isAllowedFileSchemeAccess", "isAllowedIncognitoAccess", "setUpdateUrlData"],
    events: [],
  },
  tabs: {
    methods: [
      "get",
      "getCurrent",
      "query",
      "create",
      "update",
      "remove",
      "reload",
      "duplicate",
      "move",
      "highlight",
      "discard",
      "goBack",
      "goForward",
      "captureVisibleTab",
      "getZoom",
      "setZoom",
      "getZoomSettings",
      "setZoomSettings",
      "detectLanguage",
      "group",
      "ungroup",
    ],
    events: [
      "onCreated",
      "onUpdated",
      "onActivated",
      "onRemoved",
      "onMoved",
      "onHighlighted",
      "onAttached",
      "onDetached",
      "onReplaced",
      "onZoomChange",
      "onActiveChanged",
      "onHighlightChanged",
      "onSelectionChanged",
    ],
  },
  windows: {
    methods: ["get", "getCurrent", "getLastFocused", "getAll", "create", "update", "remove", "closeSelf"],
    events: ["onCreated", "onRemoved", "onFocusChanged", "onBoundsChanged"],
  },
  contextMenus: {
    methods: ["remove", "removeAll", "create", "update"],
    events: ["onClicked", "onclick"],
  },
  commands: {
    methods: ["getAll"],
    events: ["onCommand"],
  },
  permissions: {
    methods: ["contains", "getAll", "request", "remove", "addHostAccessRequest", "removeHostAccessRequest"],
    events: ["onAdded", "onRemoved"],
  },
  cookies: {
    methods: ["get", "getAll", "set", "remove", "getAllCookieStores", "getPartitionKey"],
    events: ["onChanged"],
  },
  webNavigation: {
    methods: ["getFrame", "getAllFrames"],
    events: [
      "onBeforeNavigate",
      "onCommitted",
      "onDOMContentLoaded",
      "onCompleted",
      "onErrorOccurred",
      "onCreatedNavigationTarget",
      "onReferenceFragmentUpdated",
      "onTabReplaced",
      "onHistoryStateUpdated",
    ],
  },
  notifications: {
    methods: ["create", "update", "clear", "getAll", "getPermissionLevel"],
    events: ["onClosed", "onClicked", "onButtonClicked", "onPermissionLevelChanged", "onShowSettings"],
  },
  sidePanel: {
    methods: ["setOptions", "getOptions", "setPanelBehavior", "getPanelBehavior", "open", "close", "getLayout"],
    events: ["onOpened", "onClosed"],
  },
  management: {
    methods: [
      "getAll",
      "get",
      "getSelf",
      "getPermissionWarningsById",
      "getPermissionWarningsByManifest",
      "setEnabled",
      "uninstall",
      "uninstallSelf",
      "launchApp",
      "createAppShortcut",
      "setLaunchType",
      "generateAppForLink",
    ],
    events: ["onInstalled", "onUninstalled", "onEnabled", "onDisabled"],
  },
  history: {
    methods: ["search", "getVisits", "addUrl", "deleteUrl", "deleteRange", "deleteAll"],
    events: ["onVisited", "onVisitRemoved"],
  },
  downloads: {
    methods: [
      "download",
      "search",
      "pause",
      "resume",
      "cancel",
      "getFileIcon",
      "open",
      "show",
      "showDefaultFolder",
      "erase",
      "removeFile",
      "acceptDanger",
      "setShelfEnabled",
      "setUiOptions",
    ],
    events: ["onCreated", "onErased", "onChanged", "onDeterminingFilename"],
  },
  downloadsInternal: {
    methods: ["determineFilename"],
    events: [],
  },
  bookmarks: {
    methods: [
      "get",
      "getChildren",
      "getRecent",
      "getTree",
      "getSubTree",
      "search",
      "create",
      "move",
      "update",
      "remove",
      "removeTree",
    ],
    events: ["onCreated", "onRemoved", "onChanged", "onMoved", "onChildrenReordered", "onImportBegan", "onImportEnded"],
  },
  sessions: {
    methods: ["getRecentlyClosed", "getDevices", "restore"],
    events: ["onChanged"],
  },
  identity: {
    methods: [
      "launchWebAuthFlow",
      "getAuthToken",
      "removeCachedAuthToken",
      "clearAllCachedAuthTokens",
      "getProfileUserInfo",
      "getAccounts",
    ],
    events: ["onSignInChanged"],
  },
  browsingData: {
    methods: [
      "remove",
      "removeAppcache",
      "removeCache",
      "removeCacheStorage",
      "removeCookies",
      "removeDownloads",
      "removeFileSystems",
      "removeFormData",
      "removeHistory",
      "removeIndexedDB",
      "removeLocalStorage",
      "removePasswords",
      "removePluginData",
      "removeServiceWorkers",
      "removeWebSQL",
      "settings",
    ],
    events: [],
  },
  debugger: {
    methods: ["attach", "detach", "sendCommand", "getTargets"],
    events: ["onEvent", "onDetach"],
  },
  tabGroups: {
    methods: ["get", "query", "update", "move"],
    events: ["onCreated", "onUpdated", "onMoved", "onRemoved"],
  },
  runtime: {
    methods: [
      "openOptionsPage",
      "getContexts",
      "setUninstallURL",
      "requestUpdateCheck",
      "sendNativeMessage",
      "nativeConnect",
      "nativePost",
      "nativeDisconnect",
      "watchSenderTabs",
    ],
    events: ["onInstalled", "onStartup", "nativeMessage", "nativeDisconnect", "senderTabs", "permissionsChanged"],
  },
  action: {
    methods: [
      "setTitle",
      "getTitle",
      "setIcon",
      "setPopup",
      "getPopup",
      "setBadgeText",
      "getBadgeText",
      "setBadgeBackgroundColor",
      "getBadgeBackgroundColor",
      "setBadgeTextColor",
      "getBadgeTextColor",
      "enable",
      "disable",
      "isEnabled",
      "openPopup",
      "getUserSettings",
    ],
    events: ["onClicked", "onUserSettingsChanged"],
  },
  search: {
    methods: ["query"],
    events: [],
  },
  omnibox: {
    methods: ["setDefaultSuggestion", "sendSuggestions"],
    events: ["onInputStarted", "onInputChanged", "onInputEntered", "onInputCancelled", "onDeleteSuggestion", "onActionExecuted"],
  },
  declarativeContent: {
    methods: ["addRules", "getRules", "removeRules"],
    events: ["inject"],
  },
  topSites: {
    methods: ["get"],
    events: [],
  },
} satisfies Record<string, ApiNamespace>;

export type ApiSpec = typeof API_SPEC;

export const API_METHODS = new Set(
  Object.entries(API_SPEC).flatMap(([namespace, api]) => api.methods.map((method) => `${namespace}.${method}`)),
);

export const API_EVENTS = new Set(
  Object.entries(API_SPEC).flatMap(([namespace, api]) => api.events.map((event) => `${namespace}.${event}`)),
);

export const EVENT_CHANNEL = "tb-ext:event";
export const LISTEN_CHANNEL = "tb-ext:listen";
export const UNLISTEN_CHANNEL = "tb-ext:unlisten";
export const READY_CHANNEL = "tb-ext:ready";
export const VIEW_INFO_CHANNEL = "tb-ext:view-info";
export const STARTUP_CHANNEL = "tb-ext:startup";

// What an extension context needs before its own scripts run.
export interface StartupInfo {
  permissions: string[];
}

// Where an extension page is shown, for chrome.extension.getViews.
export interface ViewInfo {
  type: "tab" | "popup" | "side_panel" | "offscreen" | null;
  windowId: number;
  tabId: number;
}

export function channelFor(method: string): string {
  return `tb-ext:${method}`;
}
