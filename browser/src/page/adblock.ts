import fs from "node:fs";
import path from "node:path";

import { app, ipcMain, utilityProcess } from "electron";
import type {
  CallbackResponse,
  HeadersReceivedResponse,
  OnBeforeRequestListenerDetails,
  OnHeadersReceivedListenerDetails,
  Session,
} from "electron";
import { ElectronBlocker } from "@ghostery/adblocker-electron";
import { parse } from "tldts-experimental";
import { appLog } from "pixel-react";
import {
  ADBLOCK_DIR,
  adblockAllowlist,
  adblockEnabled,
  setAdblockAllowlist,
  setAdblockEnabled,
} from "pixel-store";

// must match the channels @ghostery/adblocker-electron-preload talks on
const INJECT_CHANNEL = "@ghostery/adblocker/inject-cosmetic-filters";
const MUTATION_OBSERVER_CHANNEL = "@ghostery/adblocker/is-mutation-observer-enabled";
const EARLY_CHANNEL = "terminal-browser:adblock-early";

// scriptlets only beat a page's anti-adblock code if they run before its own scripts, so this
// preload asks for them synchronously instead of waiting on a round trip
const EARLY_PRELOAD = `const { ipcRenderer, webFrame } = require("electron");

if (/^https?:$/.test(window.location.protocol)) {
  const cosmetics = ipcRenderer.sendSync(${JSON.stringify(EARLY_CHANNEL)}, window.location.href);
  if (cosmetics) {
    if (cosmetics.styles) {
      webFrame.insertCSS(cosmetics.styles, { cssOrigin: "user" });
    }
    const scripts = cosmetics.scripts || [];
    if (scripts.length > 0) {
      // several scriptlets declare the same classes, so each one needs its own scope
      const sources = scripts.map((code) => "(function(){" + code + "\\n})();");
      const trusted = (() => {
        const types = window.trustedTypes;
        if (!types || !types.createPolicy) return (code) => code;
        try {
          const policy = types.createPolicy("terminal-browser-adblock", {
            createScript: (code) => code,
          });
          return (code) => policy.createScript(code);
        } catch (error) {
          return (code) => code;
        }
      })();
      const inject = () => {
        const root = document.documentElement || document.head || document.body;
        if (!root) return false;
        try {
          for (const source of sources) {
            const element = document.createElement("script");
            element.textContent = trusted(source);
            root.appendChild(element);
            element.remove();
          }
        } catch (error) {
          // a page can refuse script text outright, and evaluating it is not subject to that
          webFrame.executeJavaScriptInIsolatedWorld(0, sources.map((code) => ({ code })));
        }
        return true;
      };
      if (!inject()) {
        const observer = new MutationObserver(() => {
          if (inject()) observer.disconnect();
        });
        observer.observe(document, { childList: true, subtree: true });
      }
    }
  }
}
`;

const ENGINE_FILE = path.join(ADBLOCK_DIR, "engine.bin");
const REFRESH_AFTER_MS = 6 * 60 * 60 * 1000;

// a page can block dozens of requests at once, and every report repaints the whole ui
const REPORT_INTERVAL_MS = 250;

type CosmeticMessage = Parameters<ElectronBlocker["onInjectCosmeticFilters"]>[2];

interface Page {
  host: string;
  enabled: boolean;
  blocked: number;
  onBlocked: ((blocked: number) => void) | null;
  pending: ReturnType<typeof setTimeout> | null;
}

const pages = new Map<number, Page>();
let engine: ElectronBlocker | null = null;
let started = false;
let globallyOn = true;
let allowlist = new Set<string>();

export function startAdblock(): void {
  if (started) return;
  started = true;
  globallyOn = readSetting(adblockEnabled, true);
  allowlist = new Set(readSetting(adblockAllowlist, []));

  const cached = deserializeEngine(ENGINE_FILE);
  const bundled = distFile("adblock-engine.bin");
  engine = cached ?? (bundled ? deserializeEngine(bundled) : null);
  if (!engine || ageOf(ENGINE_FILE) > REFRESH_AFTER_MS) refreshFilters();

  // the page is blocked on this reply, so it always gets one
  ipcMain.on(EARLY_CHANNEL, (event, url: string) => {
    try {
      event.returnValue = cosmeticsFor(event.sender.id, url, null);
    } catch (error) {
      event.returnValue = null;
      appLog("warn", "adblock", `cosmetic lookup failed for ${url}: ${message(error)}`);
    }
  });

  // the early preload already injected everything that does not depend on the page's dom
  ipcMain.handle(INJECT_CHANNEL, (event, url: string, update: CosmeticMessage) => {
    if (!update) return;
    const cosmetics = cosmeticsFor(event.sender.id, url, update);
    if (cosmetics?.styles) event.sender.insertCSS(cosmetics.styles, { cssOrigin: "user" });
  });
  ipcMain.handle(
    MUTATION_OBSERVER_CHANNEL,
    (event) => activeFor(event.sender.id) && (engine?.config.enableMutationObserver ?? false),
  );

  setInterval(refreshFilters, REFRESH_AFTER_MS).unref();
}

function cosmeticsFor(
  webContentsId: number,
  url: string,
  update: CosmeticMessage | null,
): { styles: string; scripts: string[] } | null {
  if (!engine || !activeFor(webContentsId)) return null;
  const parsed = parse(url);
  const fromDom = update !== null && update !== undefined;
  const { active, styles, scripts } = engine.getCosmeticsFilters({
    domain: parsed.domain ?? "",
    hostname: parsed.hostname ?? "",
    url,
    classes: update?.classes,
    hrefs: update?.hrefs,
    ids: update?.ids,
    getBaseRules: !fromDom,
    getInjectionRules: !fromDom,
    getRulesFromHostname: !fromDom,
    getRulesFromDOM: fromDom,
    getExtendedRules: false,
  });
  return active ? { styles, scripts } : null;
}

export function attachAdblock(target: Session): void {
  target.registerPreloadScript({ type: "frame", filePath: earlyPreloadPath() });
  const preload = preloadPath();
  if (preload) target.registerPreloadScript({ type: "frame", filePath: preload });
  target.webRequest.onHeadersReceived({ urls: ["<all_urls>"] }, (details, callback) => {
    if (!adblockHeadersReceived(details, callback)) callback({});
  });
}

export function adblockBeforeRequest(
  details: OnBeforeRequestListenerDetails,
  callback: (response: CallbackResponse) => void,
): boolean {
  const current = engine;
  if (!current || !activeFor(details.webContentsId)) return false;
  current.onBeforeRequest(details, (response) => {
    const stopped = response.cancel === true || response.redirectURL !== undefined;
    if (stopped) count(details.webContentsId);
    callback(response);
  });
  return true;
}

function adblockHeadersReceived(
  details: OnHeadersReceivedListenerDetails,
  callback: (response: HeadersReceivedResponse) => void,
): boolean {
  const current = engine;
  if (!current || !activeFor(details.webContentsId)) return false;
  current.onHeadersReceived(details, callback);
  return true;
}

export function adblockOpenPage(
  webContentsId: number,
  enabled: boolean,
  onBlocked: ((blocked: number) => void) | null = null,
): void {
  pages.set(webContentsId, { host: "", enabled, blocked: 0, onBlocked, pending: null });
}

export function adblockPageNavigated(webContentsId: number, host: string): void {
  const page = pages.get(webContentsId);
  if (!page) return;
  clearPending(page);
  page.host = host;
  page.blocked = 0;
  page.onBlocked?.(0);
}

export function adblockClosePage(webContentsId: number): void {
  const page = pages.get(webContentsId);
  if (page) clearPending(page);
  pages.delete(webContentsId);
}

export function adblockOn(): boolean {
  return globallyOn;
}

export function setAdblockOn(on: boolean): void {
  globallyOn = on;
  try {
    setAdblockEnabled(on);
  } catch {}
}

export function adblockHostAllowed(host: string): boolean {
  return allowlist.has(host);
}

export function setAdblockHostAllowed(host: string, allowed: boolean): void {
  if (!host) return;
  if (allowed) allowlist.add(host);
  else allowlist.delete(host);
  try {
    setAdblockAllowlist([...allowlist]);
  } catch {}
}

function activeFor(webContentsId: number | undefined): boolean {
  if (!globallyOn) return false;
  if (webContentsId === undefined) return true;
  // windows nobody registered are devtools, which nothing should be blocked in
  const page = pages.get(webContentsId);
  if (!page) return false;
  return page.enabled && !allowlist.has(page.host);
}

function count(webContentsId: number | undefined): void {
  if (webContentsId === undefined) return;
  const page = pages.get(webContentsId);
  if (!page) return;
  page.blocked += 1;
  if (!page.onBlocked || page.pending) return;
  page.pending = setTimeout(() => {
    page.pending = null;
    page.onBlocked?.(page.blocked);
  }, REPORT_INTERVAL_MS);
}

function clearPending(page: Page): void {
  if (!page.pending) return;
  clearTimeout(page.pending);
  page.pending = null;
}

function readSetting<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

let preloadFile: string | null | undefined;
function preloadPath(): string | null {
  if (preloadFile !== undefined) return preloadFile;
  try {
    preloadFile = require.resolve("@ghostery/adblocker-electron-preload");
  } catch (error) {
    preloadFile = null;
    appLog("warn", "adblock", `cosmetic filters are off: ${message(error)}`);
  }
  return preloadFile;
}

// bundled releases put these next to main.js, the dev build one directory up from this file
function distFile(name: string): string | null {
  for (const dir of [__dirname, path.join(__dirname, "..")]) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

let earlyPreloadFile: string | null = null;
function earlyPreloadPath(): string {
  if (!earlyPreloadFile) {
    earlyPreloadFile = path.join(app.getPath("userData"), "terminal-browser-adblock-preload.js");
    fs.writeFileSync(earlyPreloadFile, EARLY_PRELOAD);
  }
  return earlyPreloadFile;
}

function deserializeEngine(file: string): ElectronBlocker | null {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    return null;
  }
  const at = Date.now();
  try {
    const loaded = ElectronBlocker.deserialize(bytes);
    appLog("info", "adblock", `loaded ${file} in ${Date.now() - at}ms`);
    return loaded;
  } catch (error) {
    appLog("warn", "adblock", `${file} is unusable, refetching filters: ${message(error)}`);
    return null;
  }
}

// parsing the lists costs about half a second, which would be half a second of dropped frames
function buildFilters(): Promise<boolean> {
  return new Promise((resolve) => {
    const worker = distFile("adblock-worker.js");
    if (!worker) {
      appLog("warn", "adblock", "filter worker is missing, cannot update filters");
      resolve(false);
      return;
    }
    try {
      fs.mkdirSync(ADBLOCK_DIR, { recursive: true });
    } catch {}
    const at = Date.now();
    const child = utilityProcess.fork(worker, [ENGINE_FILE], { stdio: "pipe" });
    let failure = "";
    child.stderr?.on("data", (chunk: Buffer) => (failure += String(chunk)));
    child.on("exit", (code) => {
      if (code !== 0) {
        appLog("warn", "adblock", `filter update failed: ${failure.trim() || `exit ${code}`}`);
        resolve(false);
        return;
      }
      const next = deserializeEngine(ENGINE_FILE);
      if (next) engine = next;
      appLog("info", "adblock", `filters updated in ${Date.now() - at}ms`);
      resolve(next !== null);
    });
  });
}

let refreshing: Promise<boolean> | null = null;

export function updateAdblockFilters(): Promise<boolean> {
  refreshing ??= buildFilters().then(
    (updated) => {
      refreshing = null;
      return updated;
    },
    () => {
      refreshing = null;
      return false;
    },
  );
  return refreshing;
}

export function adblockUpdating(): boolean {
  return refreshing !== null;
}

export function adblockFiltersAge(): number | null {
  const age = ageOf(ENGINE_FILE);
  return Number.isFinite(age) ? age : null;
}

function refreshFilters(): void {
  void updateAdblockFilters();
}

function ageOf(file: string): number {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return Infinity;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
