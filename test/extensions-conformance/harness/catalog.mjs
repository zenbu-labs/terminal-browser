// Every namespace in https://developer.chrome.com/docs/extensions/reference/api
// with what terminal-browser claims for it (PR #237 / FINAL-REPORT.md).
//   supported      must behave like Chrome
//   stubbed        present but documented as a no-op
//   unsupported    documented as not implemented; must fail cleanly, never crash
//   not-on-stable  dev-channel or policy-only in Chrome; absent on stable is correct
//   chromeos       ChromeOS-only; absent on macOS in Chrome too
export const CATALOG = {
  accessibilityFeatures: { support: "supported", source: "ours" },
  action: { support: "supported", source: "ours" },
  alarms: { support: "supported", source: "electron" },
  audio: { support: "chromeos", source: "none" },
  bookmarks: { support: "supported", source: "ours", note: "minimal store" },
  browsingData: { support: "supported", source: "ours" },
  certificateProvider: { support: "chromeos", source: "none" },
  commands: { support: "supported", source: "ours" },
  contentSettings: { support: "supported", source: "ours" },
  contextMenus: { support: "supported", source: "ours" },
  cookies: { support: "supported", source: "ours" },
  debugger: { support: "supported", source: "ours", note: "multiplexed, gated" },
  declarativeContent: { support: "unknown", source: "none", note: "not mentioned anywhere in the PR" },
  declarativeNetRequest: { support: "supported", source: "electron", note: "static rulesets via patch 0009" },
  desktopCapture: { support: "unsupported", source: "none", note: "PR: not supported" },
  devtools: { support: "supported", source: "electron" },
  "devtools.inspectedWindow": { support: "supported", source: "electron" },
  "devtools.network": { support: "supported", source: "electron" },
  "devtools.panels": { support: "supported", source: "electron" },
  "devtools.performance": { support: "supported", source: "electron" },
  "devtools.recorder": { support: "supported", source: "electron" },
  dns: { support: "not-on-stable", source: "electron", note: "Dev channel in Chrome" },
  documentScan: { support: "chromeos", source: "none" },
  dom: { support: "supported", source: "electron" },
  downloads: { support: "supported", source: "ours" },
  enterprise: { support: "chromeos", source: "none", note: "enterprise.* are ChromeOS / policy-installed only" },
  events: { support: "supported", source: "electron" },
  extension: { support: "supported", source: "ours" },
  extensionTypes: { support: "supported", source: "electron", note: "types only" },
  fileBrowserHandler: { support: "chromeos", source: "none" },
  fileSystemProvider: { support: "chromeos", source: "none" },
  fontSettings: { support: "supported", source: "ours" },
  gcm: { support: "unsupported", source: "none", note: "FINAL-REPORT: intentionally absent" },
  history: { support: "supported", source: "ours" },
  i18n: { support: "supported", source: "electron" },
  identity: { support: "supported", source: "ours", note: "launchWebAuthFlow/getRedirectURL; getAuthToken unsupported (no Chrome sign-in)" },
  idle: { support: "supported", source: "electron" },
  input: { support: "chromeos", source: "none" },
  instanceID: { support: "unknown", source: "none", note: "not mentioned in the PR" },
  loginState: { support: "chromeos", source: "none" },
  management: { support: "supported", source: "ours" },
  mimeHandler: { support: "not-on-stable", source: "none", note: "allowlisted extensions only" },
  notifications: { support: "supported", source: "ours" },
  offscreen: { support: "supported", source: "electron" },
  omnibox: { support: "unknown", source: "none", note: "not mentioned in the PR" },
  pageCapture: { support: "supported", source: "ours" },
  permissions: { support: "supported", source: "ours" },
  platformKeys: { support: "chromeos", source: "none" },
  power: { support: "supported", source: "electron" },
  printerProvider: { support: "unknown", source: "none", note: "not mentioned in the PR" },
  printing: { support: "chromeos", source: "none" },
  printingMetrics: { support: "chromeos", source: "none" },
  privacy: { support: "supported", source: "ours" },
  processes: { support: "not-on-stable", source: "none", note: "Dev channel in Chrome" },
  proxy: { support: "supported", source: "electron" },
  publicSuffix: { support: "unknown", source: "none", note: "Chrome 153+, newer than Electron 44's Chromium" },
  readingList: { support: "unsupported", source: "none", note: "FINAL-REPORT: intentionally absent" },
  runtime: { support: "supported", source: "electron+ours" },
  scripting: { support: "supported", source: "electron" },
  search: { support: "supported", source: "ours" },
  sessions: { support: "supported", source: "ours" },
  sidePanel: { support: "supported", source: "ours" },
  storage: { support: "supported", source: "electron", note: "sync via patch 0013, managed empty" },
  system: { support: "supported", source: "electron" },
  systemLog: { support: "chromeos", source: "none" },
  tabCapture: { support: "unsupported", source: "none", note: "PR: not supported" },
  tabGroups: { support: "stubbed", source: "ours", note: "PR: no tab groups; APIs are no-ops" },
  tabs: { support: "supported", source: "ours" },
  topSites: { support: "supported", source: "ours" },
  tts: { support: "supported", source: "ours" },
  ttsEngine: { support: "supported", source: "ours" },
  types: { support: "supported", source: "electron" },
  userScripts: { support: "supported", source: "electron", note: "patch 0017" },
  vpnProvider: { support: "chromeos", source: "none" },
  wallpaper: { support: "chromeos", source: "none" },
  webAuthenticationProxy: { support: "unknown", source: "none", note: "not mentioned in the PR" },
  webNavigation: { support: "supported", source: "ours" },
  webRequest: { support: "supported", source: "electron" },
  windows: { support: "supported", source: "ours" },
  clipboard: { support: "chromeos", source: "none", note: "not in the public docs index" },
  // Not namespaces, but checked like them.
  web_accessible_resources: { support: "supported", source: "electron" },
  externally_connectable: { support: "supported", source: "electron" },
  chrome_url_overrides: { support: "supported", source: "ours" },
  context: { support: "supported", source: "ours" },
  gating: { support: "supported", source: "ours" },
  web: { support: "supported", source: "electron" },
  api: { support: "supported", source: "electron" },
  "browser-namespace": { support: "unknown", source: "none", note: "Chrome 148+ exposes browser.* as an alias" },
  interactive: { support: "supported", source: "ours" },
  harness: { support: "supported", source: "ours" },
};

// Maps a check id or surface member to its catalog namespace.
export function namespaceOf(id, ctx) {
  if (ctx === "noperm" || id.startsWith("gating.")) return "gating";
  if (ctx === "web" || id.startsWith("web.")) return "externally_connectable";
  if (/^tabs\.(group|ungroup)/.test(id)) return "tabGroups";
  const head = id.split(/[.#]/)[0];
  if (head === "devtools" || head === "system" || head === "enterprise") {
    const two = id.split(/[.#]/).slice(0, 2).join(".");
    return CATALOG[two] ? two : head;
  }
  return head;
}
