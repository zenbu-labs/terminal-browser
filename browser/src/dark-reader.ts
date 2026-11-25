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
let pageSource: string | null = null;
const owners = new Set<(contents: WebContents) => boolean | null>();
const darkThemeDetectedAt = new WeakMap<WebContents, string>();

function wanted(contents: WebContents): boolean {
  for (const owner of owners) {
    const answer = owner(contents);
    if (answer !== null) return answer;
  }
  return false;
}

function themeFor(contents: WebContents, frame: WebFrameMain) {
  const tabUrl = frame.top?.url ?? frame.url;
  if (!wanted(contents) || !/^https?:/.test(frame.url)) return null;
  sites ??= require(asset("sites.js")) as Sites;
  if (sites.isDarkSite(tabUrl) || darkThemeDetectedAt.get(contents) === tabUrl) return null;
  const detectorHints = sites.detectorHintsFor(frame.url);
  return {
    fixes: sites.fixesFor(frame.url),
    detectDarkTheme: frame === frame.top || Boolean(detectorHints?.some((hint) => hint.iframe)),
    detectorHints,
  };
}

ipcMain.on(SYNC, (event, loaded: boolean) => {
  const theme = event.senderFrame && themeFor(event.sender, event.senderFrame);
  if (!theme) return void (event.returnValue = null);
  pageSource ??= fs.readFileSync(asset("page.js"), "utf8");
  event.returnValue = { source: loaded ? null : pageSource, theme };
});

ipcMain.on(DETECTED, (event) => {
  const tabUrl = event.senderFrame?.top?.url;
  if (!tabUrl) return;
  darkThemeDetectedAt.set(event.sender, tabUrl);
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
  let darkReaderLoaded = false;
  const syncDarkReader = () => {
    const reply = ipcRenderer.sendSync(${JSON.stringify(SYNC)}, darkReaderLoaded);
    if (!reply && !darkReaderLoaded) return;
    const code = reply ? \`\${reply.source ?? ""};darkReader.apply(\${JSON.stringify(reply.theme)})\` : "darkReader.remove()";
    darkReaderLoaded = true;
    void webFrame.executeJavaScriptInIsolatedWorld(${WORLD_ID}, [{ code }]);
  };
  syncDarkReader();
  ipcRenderer.on(${JSON.stringify(SYNC)}, syncDarkReader);
`;
