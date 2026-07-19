import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { app, screen } from "electron";
import { createRoot } from "pixel-react";
import type { EngineInfo, EngineKeyEvent, KeyMods, PixelRoot, Surface } from "pixel-react";
import { detectBackend } from "pixel-terminals";
import type { Backend } from "pixel-terminals";
import { BrowserController } from "./browser";
import type { BrowserSurfaceLayout, DeviceSpec } from "./browser";
import { Chrome } from "./chrome";
import type {
  BrowserState,
  ChromeActions,
  ChromeLayout,
  DeviceView,
  PopupView,
} from "./chrome";
import { Registry } from "./registry";

export interface SessionContext {
  /** tty path to render on; undefined drives this process's own stdio */
  tty?: string;
  /** unique per pane: the pid for dedicated processes, pid-N for daemon sessions */
  key: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  cdpPort: number | null;
  onClose(code: number): void;
}

export interface SessionHandle {
  ready: Promise<void>;
  close(code?: number): void;
  nudgeResize(): void;
}

export function createSession(ctx: SessionContext): SessionHandle {

const DEFAULT_URL = "https://github.com/zenbu-labs";
const LAST_URL_FILE = path.join(os.homedir(), ".pixel-browser", "last-url");

function rememberUrl(url: string) {
  if (!/^https?:\/\//.test(url)) return;
  try {
    fs.writeFileSync(LAST_URL_FILE, url);
  } catch {}
}

function terminalBackend(): Backend | null {
  try {
    return detectBackend();
  } catch {
    return null;
  }
}

const backend = terminalBackend();

let root: PixelRoot;
let pageSurface: Surface;
let popupSurface: Surface;
let browser: BrowserController | null = null;
let registry: Registry | null = null;
let browserFocused = false;
let shuttingDown = false;
let findOpen = false;
let state: BrowserState = {
  url: initialUrl(),
  title: "",
  favicon: null,
  loading: true,
  canGoBack: false,
  canGoForward: false,
  findMatches: null,
};
let layout: ChromeLayout;
let surfaceLayout: BrowserSurfaceLayout;
let fontId = 0;
let displayScale = 1;

type DeviceMode = "desktop" | "phone" | "tablet";

const DEVICES: Record<Exclude<DeviceMode, "desktop">, DeviceSpec> = {
  phone: {
    width: 393,
    height: 852,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  },
  tablet: {
    width: 820,
    height: 1180,
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  },
};

let deviceMode: DeviceMode = "desktop";
let deviceView: DeviceView | null = null;

interface Tab {
  id: number;
  controller: BrowserController;
  state: BrowserState;
}

let tabs: Tab[] = [];
let activeTabId = 0;
let tabSeq = 1;

interface NewTabSession {
  query: string;
  suggestions: string[];
  /** -1 targets the typed query; 0.. target a suggestion */
  index: number;
  seq: number;
  timer: ReturnType<typeof setTimeout> | null;
}

let newTabSession: NewTabSession | null = null;
let windowBg = "#1e2026";
let palette: { query: string; index: number } | null = null;
const pendingUrl = emptyFlag();
const hideToolbar = ctx.argv.includes("--no-toolbar");
const sessionPartition =
  ctx.argv.find((argument) => argument.startsWith("--partition="))?.slice("--partition=".length) ?? null;
const marker = `pixel-browser:${ctx.key}`;
const paletteBinding = keyBinding("--palette-key", "super+p");
const findBinding = keyBinding("--find-key", "super+shift+f");

function bindingFlag(flag: string, fallback: string): string {
  return (
    ctx.argv
      .find((argument) => argument.startsWith(`${flag}=`))
      ?.slice(flag.length + 1) ?? fallback
  );
}

function parseMods(parts: string[]): KeyMods {
  const mods = { super: false, ctrl: false, alt: false, shift: false };
  for (const part of parts) {
    if (part === "cmd" || part === "super") mods.super = true;
    else if (part === "ctrl") mods.ctrl = true;
    else if (part === "alt" || part === "option") mods.alt = true;
    else if (part === "shift") mods.shift = true;
  }
  return mods;
}

function keyBinding(flag: string, fallback: string): (KeyMods & { key: string }) | null {
  const spec = bindingFlag(flag, fallback);
  if (spec === "none") return null;
  const parts = spec.toLowerCase().split("+");
  const key = parts.pop() ?? "";
  return { ...parseMods(parts), key };
}

function matchesMods(event: EngineKeyEvent, mods: KeyMods): boolean {
  return (
    event.mods.super === mods.super &&
    event.mods.ctrl === mods.ctrl &&
    event.mods.alt === mods.alt &&
    event.mods.shift === mods.shift
  );
}

function matchesBinding(event: EngineKeyEvent, binding: (KeyMods & { key: string }) | null): boolean {
  return binding !== null && event.key.toLowerCase() === binding.key && matchesMods(event, binding);
}

function bindingGlyphs(mods: KeyMods | null): string {
  if (!mods) return "";
  return `${mods.super ? "⌘" : ""}${mods.ctrl ? "⌃" : ""}${mods.alt ? "⌥" : ""}${mods.shift ? "⇧" : ""}`;
}

let pageHover = false;
let sentCursor: string | null = null;

/** mirror the page's css cursor onto the terminal pointer while the mouse is
 * over the page surface; anywhere else in the chrome shows a plain arrow */
function syncCursor() {
  const shape = pageHover ? (browser?.cursorShape ?? "default") : "default";
  if (shape === sentCursor) return;
  sentCursor = shape;
  root?.setPointerShape(shape);
}

function createTab(url: string, activate = true): Tab {
  const tab: Tab = {
    id: tabSeq++,
    state: {
      url,
      title: "",
      favicon: null,
      loading: true,
      canGoBack: false,
      canGoForward: false,
      findMatches: null,
    },
    controller: null as unknown as BrowserController,
  };
  let lastUrl = url;
  tab.controller = new BrowserController(
    pageSurface,
    popupSurface,
    surfaceLayout,
    url,
    windowBg,
    activate,
    sessionPartition,
    (next) => {
      tab.state = next;
      if (tab.id === activeTabId) {
        state = next;
        if (state.url !== lastUrl) {
          lastUrl = state.url;
          rememberUrl(state.url);
        }
        registry?.update();
      }
      render();
    },
  );
  tab.controller.onCursorChange = () => {
    if (tab.id === activeTabId) syncCursor();
  };
  tab.controller.onOpenTab = (openUrl, activate) => {
    createTab(openUrl, activate);
  };
  tab.controller.onPopupChange = () => render();
  tabs.push(tab);
  if (activate) activateTab(tab.id);
  return tab;
}

function activateTab(id: number) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  if (activeTabId !== id) {
    const previous = tabs.find((t) => t.id === activeTabId);
    previous?.controller.setVisible(false);
  }
  activeTabId = id;
  browser = tab.controller;
  state = tab.state;
  tab.controller.setDevice(deviceMode === "desktop" ? null : DEVICES[deviceMode]);
  tab.controller.setVisible(true);
  browserFocused = true;
  tab.controller.focusContent();
  syncCursor();
  registry?.update();
  render();
}

function closeTab(id: number) {
  const at = tabs.findIndex((t) => t.id === id);
  if (at < 0) return;
  const [closed] = tabs.splice(at, 1);
  closed.controller.stop();
  if (activeTabId === id) {
    const fallback = tabs[Math.min(at, tabs.length - 1)];
    if (fallback) activateTab(fallback.id);
    else createTab(DEFAULT_URL);
  }
  render();
}

function searchOrUrl(text: string): string {
  const trimmed = text.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (!trimmed.includes(" ") && trimmed.includes(".")) return trimmed;
  if (/^[\w-]+:\d+(\/.*)?$/.test(trimmed)) return trimmed;
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

let urlEditOpen = false;

function openUrlEdit() {
  if (urlEditOpen) return;
  urlEditOpen = true;
  browserFocused = false;
  browser?.blurContent();
  render();
}

function closeUrlEdit() {
  if (!urlEditOpen) return;
  urlEditOpen = false;
  browserFocused = true;
  browser?.focusContent();
  render();
}

function openNewTabModal() {
  if (newTabSession) return;
  newTabSession = { query: "", suggestions: [], index: -1, seq: 0, timer: null };
  browserFocused = false;
  browser?.blurContent();
  root?.setKeyCapture(["enter", "up", "down"]);
  render();
}

function closeNewTabModal() {
  if (!newTabSession) return;
  if (newTabSession.timer) clearTimeout(newTabSession.timer);
  newTabSession = null;
  root?.setKeyCapture(findOpen ? ["enter"] : []);
  browserFocused = true;
  browser?.focusContent();
  render();
}

function fetchNewTabSuggestions(query: string) {
  const session = newTabSession;
  if (!session) return;
  const seq = ++session.seq;
  const url = `https://suggestqueries.google.com/complete/search?client=chrome&q=${encodeURIComponent(query)}`;
  fetch(url)
    .then((res) => res.text())
    .then((body) => {
      if (newTabSession !== session || session.seq !== seq) return;
      const parsed = JSON.parse(body) as unknown[];
      const list = Array.isArray(parsed[1]) ? (parsed[1] as unknown[]) : [];
      session.suggestions = list
        .filter((item): item is string => typeof item === "string")
        .slice(0, 6);
      if (session.index >= session.suggestions.length) session.index = -1;
      render();
    })
    .catch(() => {});
}

let closeConfirmOpen = false;

function openCloseConfirm() {
  if (closeConfirmOpen) return;
  closeConfirmOpen = true;
  browserFocused = false;
  browser?.blurContent();
  render();
}

function cancelCloseConfirm() {
  if (!closeConfirmOpen) return;
  closeConfirmOpen = false;
  browserFocused = true;
  browser?.focusContent();
  render();
}

async function resolveCloseConfirm(closePane: boolean) {
  closeConfirmOpen = false;
  if (closePane) await backend?.closePane?.(marker).catch(() => false);
  shutdown();
}

function tabsView() {
  const active = activeTabId;
  return tabs.map((tab) => ({
    id: tab.id,
    title: tab.state.title || tab.state.url.replace(/^https?:\/\//, ""),
    favicon: tab.state.favicon,
    active: tab.id === active,
    loading: tab.state.loading,
  }));
}

async function setDeviceMode(mode: DeviceMode): Promise<unknown> {
  if (!DEVICES[mode as "phone"] && mode !== "desktop") throw new Error(`unknown device: ${mode}`);
  const name = mode === "phone" ? "mobile" : mode;
  if (mode === deviceMode) return { device: name };
  deviceMode = mode;
  calculateLayout(root.info, displayScale);
  browser?.setDevice(mode === "desktop" ? null : DEVICES[mode]);
  browser?.resize(surfaceLayout);
  render();
  return { device: name };
}

interface PaletteAction {
  id: string;
  label: string;
  shortcut: string;
  run(): void;
}

function paletteActions(): PaletteAction[] {
  return [
    {
      id: "url-edit",
      label: "edit url",
      shortcut: "⌘L",
      run: () => openUrlEdit(),
    },
    {
      id: "new-tab",
      label: "new tab",
      shortcut: "⌃T",
      run: () => openNewTabModal(),
    },
    {
      id: "find",
      label: "find in page",
      shortcut: `${bindingGlyphs(findBinding)}${(findBinding?.key ?? "").toUpperCase()}`,
      run: () => openFind(),
    },
    {
      id: "device-phone",
      label: deviceMode === "phone" ? "exit mobile emulation" : "mobile emulation",
      shortcut: "",
      run: () => void setDeviceMode(deviceMode === "phone" ? "desktop" : "phone").catch(() => {}),
    },
    {
      id: "device-tablet",
      label: deviceMode === "tablet" ? "exit tablet emulation" : "tablet emulation",
      shortcut: "",
      run: () => void setDeviceMode(deviceMode === "tablet" ? "desktop" : "tablet").catch(() => {}),
    },
    ...(backend?.zoomPane
      ? [
          {
            id: "zoom-split",
            label: "full screen (zoom split)",
            shortcut: "⇧⌘↩",
            run: () => void backend.zoomPane!(marker).catch(() => false),
          },
        ]
      : []),
    ...(backend?.closePane
      ? [
          {
            id: "close-pane",
            label: "close pane",
            shortcut: "",
            run: () => void resolveCloseConfirm(true),
          },
        ]
      : []),
  ];
}

function filteredPalette(): PaletteAction[] {
  if (!palette) return [];
  const query = palette.query.toLowerCase();
  return paletteActions().filter((action) => action.label.toLowerCase().includes(query));
}

function openPalette() {
  if (palette) return;
  palette = { query: "", index: 0 };
  browserFocused = false;
  browser?.blurContent();
  root?.setKeyCapture(["enter", "up", "down"]);
  render();
}

function closePalette() {
  if (!palette) return;
  palette = null;
  root?.setKeyCapture(findOpen ? ["enter"] : []);
  browserFocused = true;
  browser?.focusContent();
  render();
}

function runPalette(index?: number) {
  const items = filteredPalette();
  const chosen = items[index ?? palette?.index ?? 0];
  closePalette();
  chosen?.run();
}

function popupView(): PopupView | null {
  const popup = browser?.popup;
  if (!popup || !layout) return null;
  const scale = surfaceLayout.scale;
  const headerPx = Math.round(layout.rem * 1.7);
  const maxW = Math.round(layout.page.width * 0.94);
  const maxH = Math.round(layout.page.height * 0.94) - headerPx;
  let host = "";
  try {
    host = new URL(popup.state.url).host;
  } catch {}
  return {
    title: popup.state.title,
    host,
    loading: popup.state.loading,
    width: Math.max(60, Math.min(Math.round(popup.state.width * scale), maxW)),
    height: Math.max(60, Math.min(Math.round(popup.state.height * scale), maxH)),
  };
}

function render() {
  if (!root || !layout) return;
  root.render(
    <Chrome
      state={state}
      actions={actions}
      layout={layout}
      colors={root.info.colors}
      font={fontId}
      findOpen={findOpen}
      device={deviceView}
      tabs={tabsView()}
      newTab={
        newTabSession
          ? { suggestions: newTabSession.suggestions, index: newTabSession.index }
          : null
      }
      closeConfirm={closeConfirmOpen}
      urlEdit={urlEditOpen}
      popup={popupView()}
      pending={pendingUrl !== null && state.url === "about:blank" ? pendingUrl : null}
      palette={
        palette
          ? {
              index: Math.min(palette.index, Math.max(0, filteredPalette().length - 1)),
              items: filteredPalette().map(({ id, label, shortcut }) => ({ id, label, shortcut })),
            }
          : null
      }
      pageSurface={pageSurface}
      popupSurface={popupSurface}
    />,
  );
}

function openFind() {
  if (findOpen) return;
  findOpen = true;
  browserFocused = false;
  browser?.blurContent();
  root?.setKeyCapture(["enter"]);
  render();
}

function closeFind() {
  if (!findOpen) return;
  findOpen = false;
  browser?.stopFind();
  root?.setKeyCapture([]);
  browserFocused = true;
  browser?.focusContent();
  render();
}

const FONT_CANDIDATES = [
  path.join(os.homedir(), "Library/Fonts/JetBrainsMono-Regular.ttf"),
  "/Library/Fonts/JetBrainsMono-Regular.ttf",
];

function loadFont() {
  const fontPath = FONT_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!fontPath) return;
  root
    .registerFont(fontPath)
    .then((id) => {
      fontId = id;
      render();
    })
    .catch(() => {});
}

const actions: ChromeActions = {
  back: () => browser?.back(),
  forward: () => browser?.forward(),
  reload: () => browser?.reload(),
  urlEdit: () => openUrlEdit(),
  urlEditCancel: () => closeUrlEdit(),
  urlSubmit: (text) => {
    closeUrlEdit();
    if (text.trim()) browser?.navigate(searchOrUrl(text));
  },
  pointer: (event) => {
    browserFocused = true;
    browser?.pointer(event);
  },
  wheel: (event) => {
    browserFocused = true;
    browser?.wheel(event);
  },
  pageHover: (hovering) => {
    pageHover = hovering;
    syncCursor();
  },
  findChange: (text) => browser?.find(text),
  findNext: (forward) => browser?.findNext(forward),
  findClose: closeFind,
  paletteQuery: (text: string) => {
    if (!palette) return;
    palette.query = text;
    palette.index = 0;
    render();
  },
  paletteRun: (index: number) => runPalette(index),
  paletteClose: () => closePalette(),
  tabSwitch: (id: number) => activateTab(id),
  tabClose: (id: number) => (tabs.length <= 1 ? openCloseConfirm() : closeTab(id)),
  tabNew: () => openNewTabModal(),
  newTabQuery: (text: string) => {
    const session = newTabSession;
    if (!session) return;
    session.query = text;
    session.index = -1;
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    if (!text.trim()) {
      session.seq++;
      session.suggestions = [];
      render();
      return;
    }
    session.timer = setTimeout(() => fetchNewTabSuggestions(text), 120);
    render();
  },
  newTabSubmit: (text: string) => {
    closeNewTabModal();
    if (text.trim()) createTab(searchOrUrl(text));
  },
  newTabCancel: () => closeNewTabModal(),
  closeConfirmChoose: (closePane: boolean) => void resolveCloseConfirm(closePane),
  closeConfirmCancel: () => cancelCloseConfirm(),
  popupPointer: (event) => browser?.popup?.input.pointer(event),
  popupWheel: (event) => browser?.popup?.input.wheel(event),
  popupClose: () => browser?.popup?.close(),
};

function handleKey(event: EngineKeyEvent) {
  if (browser?.popup) {
    if (event.kind !== "release" && event.key === "escape") {
      browser.popup.close();
      return;
    }
    if (event.kind !== "release" && event.mods.ctrl && event.key === "q") {
      shutdown();
      return;
    }
    browser.popup.input.key(event);
    return;
  }
  if (event.kind !== "release") {
    if (event.mods.ctrl && event.key === "q") {
      shutdown();
      return;
    }
    if (palette) {
      const down = event.key === "down" || (event.mods.ctrl && event.key === "n");
      const up = event.key === "up" || (event.mods.ctrl && event.key === "p");
      if (event.key === "escape" || matchesBinding(event, paletteBinding)) closePalette();
      else if (down || up) {
        const count = filteredPalette().length;
        if (count > 0) {
          palette.index = (palette.index + (down ? 1 : -1) + count) % count;
          render();
        }
      } else if (event.key === "enter") runPalette();
      return;
    }
    if (closeConfirmOpen) {
      if (event.key === "escape") cancelCloseConfirm();
      else if (event.key === "y") void resolveCloseConfirm(true);
      else if (event.key === "n") void resolveCloseConfirm(false);
      return;
    }
    if (newTabSession) {
      const session = newTabSession;
      const down = event.key === "down" || (event.mods.ctrl && event.key === "n");
      const up = event.key === "up" || (event.mods.ctrl && event.key === "p");
      if (event.key === "escape") closeNewTabModal();
      else if (down || up) {
        const count = session.suggestions.length;
        if (count > 0) {
          session.index = down
            ? session.index >= count - 1
              ? -1
              : session.index + 1
            : session.index <= -1
              ? count - 1
              : session.index - 1;
          render();
        }
      } else if (event.key === "enter") {
        const text = session.index >= 0 ? session.suggestions[session.index] : session.query;
        actions.newTabSubmit(text);
      }
      return;
    }
    if (urlEditOpen) {
      if (event.key === "escape") closeUrlEdit();
      return;
    }
    if ((event.mods.super || event.mods.ctrl) && event.key === "t") {
      openNewTabModal();
      return;
    }
    if (matchesBinding(event, paletteBinding)) {
      openPalette();
      return;
    }
    if (event.mods.super && event.key === "l") {
      openUrlEdit();
      return;
    }
    if (matchesBinding(event, findBinding)) {
      openFind();
      return;
    }
    if (event.key === "escape" && findOpen) {
      closeFind();
      return;
    }
    if (event.key === "enter" && findOpen) {
      browser?.findNext(!event.mods.shift);
      return;
    }
    if (event.mods.super && event.key === "r") {
      browser?.reload();
      return;
    }
    if ((event.mods.super || event.mods.ctrl) && event.key === "[") {
      browser?.back();
      return;
    }
    if ((event.mods.super || event.mods.ctrl) && event.key === "]") {
      browser?.forward();
      return;
    }
  }
  if (event.kind === "release") {
    browser?.key(event);
    return;
  }
  if (browserFocused) browser?.key(event);
}

function calculateLayout(info: EngineInfo, scale: number) {
  const toolbarHeight = hideToolbar
    ? 0
    : Math.min(info.height - info.cellHeight, Math.round(info.basePx * 2.1));
  const pad = Math.round(info.basePx * 0.45);
  const padLeft = Math.round(info.basePx * 0.2);
  const padBottom = Math.round(info.basePx * 0.2);
  layout = {
    width: info.width,
    height: info.height,
    toolbarHeight,
    contentHeight: Math.max(1, info.height - toolbarHeight),
    // flush on top; the host chrome provides that spacing
    page: {
      x: padLeft,
      y: toolbarHeight,
      width: Math.max(1, info.width - padLeft - pad),
      height: Math.max(1, info.height - toolbarHeight - padBottom),
    },
    rem: info.basePx,
  };
  if (deviceMode === "desktop") {
    surfaceLayout = {
      x: layout.page.x,
      y: layout.page.y,
      width: layout.page.width,
      height: layout.page.height,
      scale,
    };
    deviceView = null;
    return;
  }
  const spec = DEVICES[deviceMode];
  const margin = info.basePx * 1.1;
  const availW = Math.max(40, info.width - margin * 2);
  const availH = Math.max(40, layout.contentHeight - margin * 2);
  const bezel = deviceMode === "phone" ? 0.035 : 0.05;
  const aspect = spec.width / spec.height;
  const screenW = Math.min(availW / (1 + 2 * bezel), availH / (1 / aspect + 2 * bezel));
  const screenH = screenW / aspect;
  const bezelPx = screenW * bezel;
  const frameW = screenW + 2 * bezelPx;
  const frameH = screenH + 2 * bezelPx;
  const frameX = (info.width - frameW) / 2;
  const frameY = toolbarHeight + (layout.contentHeight - frameH) / 2;
  const screen = { x: frameX + bezelPx, y: frameY + bezelPx, w: screenW, h: screenH };
  surfaceLayout = {
    x: screen.x,
    y: screen.y,
    width: screenW,
    height: screenH,
    scale: screenW / spec.width,
  };
  const s = screenW / spec.width;
  deviceView = {
    mode: deviceMode,
    frame: {
      x: frameX,
      y: frameY,
      w: frameW,
      h: frameH,
      radius: deviceMode === "phone" ? screenW * 0.16 : screenW * 0.06,
    },
    screen,
    island:
      deviceMode === "phone"
        ? {
            x: screen.x + (screenW - 125 * s) / 2,
            y: screen.y + 11 * s,
            w: 125 * s,
            h: 37 * s,
          }
        : null,
  };
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    root?.setPointerShape("text");
  } catch {}
  registry?.dispose();
  registry = null;
  for (const tab of tabs) tab.controller.stop();
  tabs = [];
  browser = null;
  try {
    pageSurface?.close();
    popupSurface?.close();
  } catch {}
  root?.stop();
  ctx.onClose(code);
}

// Pane pixel sizes come from the host terminal, which native terminals report
// in device pixels but web-based ones (e.g. localterm) report in CSS pixels.
// The override lets those hosts force scale 1 so the page isn't zoomed 2x.
function hostDisplayScale() {
  const explicit = Number(ctx.env.PIXEL_BROWSER_DISPLAY_SCALE);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return screen.getPrimaryDisplay().scaleFactor;
}

async function start() {
  if (process.platform === "darwin") app.dock?.hide();
  if (!ctx.tty) process.stdout.write(`\x1b]2;${marker}\x07`);
  const scale = hostDisplayScale();
  displayScale = scale;
  root = createRoot({
    tty: ctx.tty,
    keyEventTypes: true,
    devtools: false,
    onKey: handleKey,
    onPaste: (text) => {
      if (browser?.popup) browser.popup.input.paste(text);
      else if (browserFocused) browser?.paste(text);
    },
    onFocus: (focused) => browser?.setActive(focused),
    onResize: () => {
      calculateLayout(root.info, scale);
      browser?.resize(surfaceLayout);
      render();
    },
    onEngineExit: (error) => {
      if (error) process.stderr.write(`pixel browser engine: ${error}\n`);
      shutdown(error ? 1 : 0);
    },
  });
  if (!root.sharedTextures) {
    throw new Error("pixel-browser requires the patched Electron with shared texture support");
  }
  pageSurface = root.createSurface();
  popupSurface = root.createSurface();
  calculateLayout(root.info, scale);
  loadFont();
  root?.setPointerShape("default");
  const themeBg = root.info.colors.background ?? [30, 32, 38, 255];
  windowBg = `#${themeBg.slice(0, 3).map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  createTab(state.url);
  registry = new Registry({
    key: ctx.key,
    tty: ctx.tty ?? null,
    state: () => state,
    openTab: (url) => void createTab(url ?? DEFAULT_URL),
    viewport: () => (root ? { width: root.info.width, height: root.info.height } : null),
    tabs: () =>
      tabs.map((tab) => ({
        id: tab.id,
        url: tab.state.url,
        title: tab.state.title,
        active: tab.id === activeTabId,
      })),
  });
  registry.setCdpPort(ctx.cdpPort);
  render();
}

function emptyFlag(): string | null {
  const flag = ctx.argv.find((argument) => argument.startsWith("--empty"));
  if (flag === undefined) return null;
  return flag.startsWith("--empty=") ? flag.slice("--empty=".length) : "";
}

function initialUrl() {
  if (emptyFlag() !== null) return "about:blank";
  const arg = ctx.argv.find((argument) => !argument.startsWith("-"));
  if (arg) return arg;
  try {
    const last = fs.readFileSync(LAST_URL_FILE, "utf8").trim();
    if (/^https?:\/\//.test(last)) return last;
  } catch {}
  return DEFAULT_URL;
}

const ready = start().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  shutdown(1);
});

return {
  ready,
  close: (code = 0) => shutdown(code),
  nudgeResize: () => root?.nudgeResize(),
};
}
