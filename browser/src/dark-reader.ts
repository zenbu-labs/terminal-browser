import fs from "node:fs";
import { ipcMain, type WebContents, type WebFrameMain } from "electron";
import { bundledAsset } from "./assets";

const SYNC = "dark-reader:sync";
const DETECTED = "dark-reader:detected";
const WORLD_ID = 1014;

interface Sites {
  isDarkSite(url: string): boolean;
  fixesFor(url: string): unknown[] | null;
  detectorHintsFor(url: string): { iframe?: boolean }[] | null;
}

function asset(name: string): string {
  const file = bundledAsset(`darkreader/${name}`);
  if (!file) throw new Error(`darkreader bundle missing: assets/darkreader/${name} (run pnpm install)`);
  return file;
}

let sites: Sites | null = null;
let sources: { page: string; proxy: string } | null = null;
const owners = new Set<(contents: WebContents) => boolean | null>();
const darkThemeDetected = new WeakSet<WebContents>();

function wanted(contents: WebContents): boolean {
  for (const owner of owners) {
    const answer = owner(contents);
    if (answer !== null) return answer;
  }
  return false;
}

// srcdoc and about:blank frames show content from the page that embeds them
function webUrl(frame: WebFrameMain): string | null {
  for (let current: WebFrameMain | null = frame; current; current = current.parent) {
    if (/^https?:/.test(current.url)) return current.url;
    if (!current.url.startsWith("about:")) return null;
  }
  return null;
}

function themeFor(contents: WebContents, frame: WebFrameMain) {
  const tabUrl = frame.top ? webUrl(frame.top) : null;
  const url = webUrl(frame);
  if (!wanted(contents) || !tabUrl || !url) return null;
  sites ??= require(asset("sites.js")) as Sites;
  if (sites.isDarkSite(tabUrl) || darkThemeDetected.has(contents)) return null;
  const detectorHints = sites.detectorHintsFor(url);
  return {
    fixes: sites.fixesFor(url),
    detectDarkTheme: frame === frame.top || Boolean(detectorHints?.some((hint) => hint.iframe)),
    detectorHints,
  };
}

ipcMain.on(SYNC, (event, loaded: boolean) => {
  const frame = event.senderFrame;
  if (frame && frame === frame.top && !loaded) darkThemeDetected.delete(event.sender);
  const theme = frame && themeFor(event.sender, frame);
  if (!theme) return void (event.returnValue = null);
  sources ??= { page: fs.readFileSync(asset("page.js"), "utf8"), proxy: fs.readFileSync(asset("proxy.js"), "utf8") };
  event.returnValue = { sources: loaded ? null : sources, theme };
});

ipcMain.on(DETECTED, (event) => {
  darkThemeDetected.add(event.sender);
  refreshDarkReader(event.sender);
});

export function registerDarkReader(owner: (contents: WebContents) => boolean | null): () => void {
  owners.add(owner);
  return () => owners.delete(owner);
}

export function refreshDarkReader(contents: WebContents): void {
  for (const frame of contents.mainFrame.framesInSubtree) frame.send(SYNC);
}

export const DARK_READER_PRELOAD = `
  webFrame.setIsolatedWorldInfo(${WORLD_ID}, { name: "terminal-browser-dark-reader" });
  contextBridge.exposeInIsolatedWorld(${WORLD_ID}, "terminalBrowserDarkReader", {
    darkThemeDetected: () => ipcRenderer.send(${JSON.stringify(DETECTED)}),
  });
  const whenDocumentExists = (run) => {
    if (document.documentElement) return run();
    new MutationObserver((_, observer) => {
      if (!document.documentElement) return;
      observer.disconnect();
      run();
    }).observe(document, { childList: true });
  };
  let darkReaderLoaded = false;
  const syncDarkReader = () => {
    const reply = ipcRenderer.sendSync(${JSON.stringify(SYNC)}, darkReaderLoaded);
    if (!reply && !darkReaderLoaded) return;
    darkReaderLoaded = true;
    whenDocumentExists(() => {
      if (!reply) return void webFrame.executeJavaScriptInIsolatedWorld(${WORLD_ID}, [{ code: "darkReader.remove()" }]);
      if (reply.sources) void webFrame.executeJavaScript(reply.sources.proxy);
      const code = \`\${reply.sources?.page ?? ""};darkReader.apply(\${JSON.stringify(reply.theme)})\`;
      void webFrame.executeJavaScriptInIsolatedWorld(${WORLD_ID}, [{ code }]);
    });
  };
  syncDarkReader();
  ipcRenderer.on(${JSON.stringify(SYNC)}, syncDarkReader);
`;
