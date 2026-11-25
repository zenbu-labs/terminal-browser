import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { Rgba, WebViewHandle } from "@zenbu-labs/pixel";
import { bundledAsset } from "../assets";
import { cssColor } from "../pages/scheme";
import { mix, withAlpha } from "../ui/theme";
import type { Theme } from "../ui/theme";

const CHANNEL = "grab";
const PLUGIN = "terminal-browser";
const SCRIPT_ASSET = "react-grab/index.global.js";
const BINDING = "__pixelEmit";
const REGION_PADDING = 8;

let librarySource: string | null = null;
function reactGrabLibrary(): string {
  if (librarySource) return librarySource;
  const file = bundledAsset(SCRIPT_ASSET);
  if (!file) throw new Error(`react-grab bundle missing: assets/${SCRIPT_ASSET} (run pnpm install)`);
  librarySource = `${fs.readFileSync(file, "utf8")}\n;undefined;`;
  return librarySource;
}

const OVERLAY_STYLE = `
[data-react-grab-completion] { display: none !important; }
[data-react-grab-selection-label]:has([data-react-grab-input]) .min-w-\\[150px\\] { min-width: min(320px, calc(100vw - 16px)) !important; max-width: min(440px, calc(100vw - 16px)) !important; }
[data-react-grab-input] { font-size: 14px !important; line-height: 20px !important; min-height: 60px !important; max-height: 160px !important; }
[data-react-grab-submit] { width: 24px !important; height: 24px !important; }
[data-react-grab-submit] svg { width: 13px; height: 13px; }
[data-react-grab-selection-label] { filter: none !important; }
[data-react-grab-selection-label] .bg-\\[var\\(--rg-panel-bg\\)\\] {
  box-shadow: 0 0 0 1px var(--rg-border-subtle), 0 12px 32px rgba(0, 0, 0, 0.28), 0 2px 8px rgba(0, 0, 0, 0.16);
  backdrop-filter: blur(16px) saturate(1.4);
}
[data-react-grab-selection-label]:has([data-react-grab-input]) .max-w-full { max-width: calc(100% - 28px) !important; }
[data-${PLUGIN}-close] {
  position: absolute; top: 4px; right: 6px; width: 20px; height: 20px; padding: 0;
  display: flex; align-items: center; justify-content: center;
  border: none; border-radius: 6px; background: transparent; color: var(--rg-text-secondary); cursor: pointer;
}
[data-${PLUGIN}-close]:hover { background: var(--rg-surface-hover); color: var(--rg-text-primary); }
`;

const CLOSE_ICON = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7"/></svg>`;

const SETUP_COMMENT_BOX = `(overlay, api) => {
  const addCloseButton = () => {
    const input = overlay.querySelector("[data-react-grab-input]");
    const label = input?.closest("[data-react-grab-selection-label]");
    const panel = label && [...label.children].find((child) => child.contains(input));
    if (!panel || panel.querySelector("[data-${PLUGIN}-close]")) return;
    const close = document.createElement("button");
    close.type = "button";
    close.setAttribute("data-${PLUGIN}-close", "");
    close.setAttribute("aria-label", "Close");
    close.innerHTML = ${JSON.stringify(CLOSE_ICON)};
    close.addEventListener("click", () => api.deactivate());
    panel.appendChild(close);
  };
  new MutationObserver(addCloseButton).observe(overlay, { childList: true, subtree: true });
  overlay.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !event.metaKey || !event.target.hasAttribute?.("data-react-grab-input")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    document.execCommand("insertText", false, "\\n");
  }, { capture: true });
}`;

const REGISTER_PLUGIN = `(api) => {
  const emit = (data) => window.${BINDING}?.(JSON.stringify({ channel: ${JSON.stringify(CHANNEL)}, data }));
  const regionAround = (elements) => {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const element of elements) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      left = Math.min(left, box.left);
      top = Math.min(top, box.top);
      right = Math.max(right, box.right);
      bottom = Math.max(bottom, box.bottom);
    }
    if (!Number.isFinite(left)) return null;
    const x = Math.max(0, left - ${REGION_PADDING});
    const y = Math.max(0, top - ${REGION_PADDING});
    const x2 = Math.min(window.innerWidth, right + ${REGION_PADDING});
    const y2 = Math.min(window.innerHeight, bottom + ${REGION_PADDING});
    return x2 - x >= 1 && y2 - y >= 1 ? { x, y, width: x2 - x, height: y2 - y } : null;
  };
  const overlay = document.querySelector("[data-react-grab]")?.shadowRoot;
  if (overlay && !overlay.querySelector("#${PLUGIN}-style")) {
    const style = document.createElement("style");
    style.id = "${PLUGIN}-style";
    style.textContent = ${JSON.stringify(OVERLAY_STYLE)};
    overlay.appendChild(style);
    (${SETUP_COMMENT_BOX})(overlay, api);
  }
  if (api.getPlugins().includes(${JSON.stringify(PLUGIN)})) return;
  let selection = null;
  api.registerPlugin({
    name: ${JSON.stringify(PLUGIN)},
    theme: { toolbar: { enabled: false } },
    hooks: {
      onActivate: () => emit({ type: "active", active: true }),
      onDeactivate: () => emit({ type: "active", active: false }),
      transformCopyContent: (content, elements) => {
        selection = { content, region: regionAround(elements) };
        return content;
      },
      // react-grab puts the user's comment in front of the content only after transformCopyContent runs
      onCopySuccess: (_elements, contentWithComment) => {
        if (selection) selection.content = contentWithComment;
      },
      onAfterCopy: () => {
        if (!selection) return;
        emit({ type: "selected", ...selection });
        selection = null;
        api.reset();
        api.deactivate();
      },
    },
  });
}`;

const COPY_ON_SELECT_BINDING = "__terminalBrowserCopyOnSelect";
const COPY_ON_SELECT_WORLD_ID = 1013;
const COPY_ON_SELECT_WORLD = "terminal-browser-copy-on-select";

const COPY_ON_SELECT_WATCHER = `;(() => {
  let last = "";
  document.addEventListener("mouseup", (e) => {
    if (!e.isTrusted) return;
    setTimeout(() => {
      const sel = window.getSelection && window.getSelection();
      const text = sel ? String(sel).trim() : "";
      if (text && text !== last && typeof window.${COPY_ON_SELECT_BINDING} === "function") {
        last = text;
        window.${COPY_ON_SELECT_BINDING}(text);
      }
    }, 0);
  });
})();`;

let preloadFile: string | null = null;
export function reactGrabPreloadPath(copyOnSelect = false): string {
  if (!preloadFile) {
    const early = `window.__REACT_GRAB_DISABLED__ = true;\n${reactGrabLibrary()}`;
    const copyOnSelectInjection = copyOnSelect
      ? `
  webFrame.setIsolatedWorldInfo(${COPY_ON_SELECT_WORLD_ID}, { name: ${JSON.stringify(COPY_ON_SELECT_WORLD)} });
  void webFrame.executeJavaScriptInIsolatedWorld(${COPY_ON_SELECT_WORLD_ID}, [{ code: ${JSON.stringify(COPY_ON_SELECT_WATCHER)} }]);`
      : "";
    preloadFile = path.join(app.getPath("userData"), "terminal-browser-react-grab-preload.js");
    fs.writeFileSync(
      preloadFile,
      `if (process.isMainFrame) {
  const { webFrame } = require("electron");
  void webFrame.executeJavaScript(${JSON.stringify(early)});${copyOnSelectInjection}
}
`,
    );
  }
  return preloadFile;
}

export class CopyOnSelect {
  private listening = false;
  private readonly onMessage = (_event: unknown, method: string, params: unknown) => {
    if (method !== "Runtime.bindingCalled") return;
    const call = params as { name: string; payload: string };
    if (call.name === COPY_ON_SELECT_BINDING) this.hooks.copied(call.payload);
  };

  constructor(
    private readonly view: WebViewHandle,
    private readonly hooks: { copied(text: string): void },
  ) {}

  async enable(): Promise<void> {
    if (this.listening) return;
    this.listening = true;
    await this.view.cdp("Runtime.addBinding", { name: COPY_ON_SELECT_BINDING, executionContextName: COPY_ON_SELECT_WORLD });
    this.view.webContents.debugger.on("message", this.onMessage);
  }

  dispose(): void {
    if (!this.listening) return;
    this.listening = false;
    try {
      this.view.webContents.debugger.removeListener("message", this.onMessage);
    } catch {}
  }
}

// while the comment box is open, react-grab would send or throw away the comment on a click outside it,
// so this listener is added before react-grab starts to see those clicks first and block them
const IGNORE_OUTSIDE_CLICKS = `(() => {
  if (window.__terminalBrowserIgnoreOutsideClicks) return;
  window.__terminalBrowserIgnoreOutsideClicks = true;
  let blocking = false;
  const commentBoxOpen = () =>
    Boolean(document.querySelector("[data-react-grab]")?.shadowRoot?.querySelector("[data-react-grab-input]"));
  const insideCommentBox = (event) =>
    event.composedPath().some((node) => node.hasAttribute?.("data-react-grab-selection-label"));
  const block = (event) => {
    if (!blocking) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  window.addEventListener("pointerdown", (event) => {
    blocking = commentBoxOpen() && !insideCommentBox(event);
    block(event);
  }, { capture: true });
  for (const type of ["mousedown", "mouseup", "click", "contextmenu"]) window.addEventListener(type, block, { capture: true });
  for (const type of ["pointerup", "pointercancel"]) {
    window.addEventListener(type, (event) => {
      block(event);
      setTimeout(() => (blocking = false));
    }, { capture: true });
  }
})()`;

function activateScript(withComment: boolean): string {
  return `(() => {
  ${IGNORE_OUTSIDE_CLICKS};
  const api = (window.__REACT_GRAB__ ??= globalThis.__REACT_GRAB_MODULE__?.init({ telemetry: false }));
  if (!api) return "missing";
  (${REGISTER_PLUGIN})(api);
  ${withComment ? "api.comment()" : "api.activate()"};
  return "active";
})()`;
}

const DEACTIVATE_SCRIPT = "window.__REACT_GRAB__?.deactivate()";

const WHITE: Rgba = [255, 255, 255, 255];

function themeStyle(theme: Theme | null): string {
  const colors = {
    "panel-bg": cssColor(theme ? withAlpha(mix(theme.overlay, WHITE, 0.1), 224) : undefined, "#262626e0"),
    "text-primary": cssColor(theme?.fg, "#fff"),
    "text-primary-85": cssColor(theme ? withAlpha(theme.fg, 217) : undefined, "#ffffffd9"),
    "text-secondary": cssColor(theme?.muted, "#a7a7a7"),
    "surface-hover": cssColor(theme?.hover, "#ffffff1a"),
    "surface-active": cssColor(theme?.hoverStrong, "#ffffff26"),
    "border-subtle": cssColor(theme?.hairline, "#ffffff1a"),
    "border-button": cssColor(theme?.fieldBorder, "#fff3"),
    "submit-bg": cssColor(theme?.fg, "#fff"),
    "submit-fg": cssColor(theme?.overlay, "#161616"),
  };
  const declarations = Object.entries(colors).map(([name, value]) => `--rg-${name}: ${value} !important;`);
  return `:host { ${declarations.join(" ")} }`;
}

function applyThemeScript(theme: Theme | null): string {
  return `(() => {
  const overlay = document.querySelector("[data-react-grab]")?.shadowRoot;
  if (!overlay) return;
  let style = overlay.getElementById("${PLUGIN}-theme");
  if (!style) {
    style = document.createElement("style");
    style.id = "${PLUGIN}-theme";
    overlay.appendChild(style);
  }
  style.textContent = ${JSON.stringify(themeStyle(theme))};
})()`;
}

export interface GrabRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

type GrabMessage =
  | { type: "active"; active: boolean }
  | { type: "selected"; content: string; region: GrabRegion | null };

export interface GrabHooks {
  selected(content: string, region: GrabRegion | null): void;
  changed(): void;
  theme(): Theme | null;
}

export class Grab {
  private _active = false;
  get active(): boolean {
    return this._active;
  }
  private set active(value: boolean) {
    if (this._active === value) return;
    this._active = value;
    this.hooks.changed();
  }
  private readonly onMessage = (_event: unknown, method: string, params: unknown) => {
    if (method === "Page.frameNavigated") {
      const frame = (params as { frame?: { parentId?: string } }).frame;
      if (!frame?.parentId) this.active = false;
      return;
    }
    if (method !== "Runtime.bindingCalled") return;
    const call = params as { name: string; payload: string };
    if (call.name !== BINDING) return;
    try {
      const message = JSON.parse(call.payload) as { channel: string; data: GrabMessage };
      if (message.channel === CHANNEL) this.receive(message.data);
    } catch {}
  };
  private listening = false;

  constructor(
    private readonly view: WebViewHandle,
    private readonly hooks: GrabHooks,
  ) {}

  private async listen(): Promise<void> {
    if (this.listening) return;
    this.listening = true;
    await this.view.cdp("Runtime.addBinding", { name: BINDING });
    this.view.webContents.debugger.on("message", this.onMessage);
  }

  private runJs(source: string): Promise<unknown> {
    return this.view.webContents.executeJavaScript(source, true);
  }

  async activate(withComment: boolean): Promise<void> {
    await this.listen();
    const loaded = await this.runJs("Boolean(window.__REACT_GRAB__)");
    if (!loaded) await this.runJs(reactGrabLibrary());
    const result = await this.runJs(activateScript(withComment));
    if (result !== "active") {
      throw new Error("react-grab failed to start");
    }
    await this.runJs(applyThemeScript(this.hooks.theme()));
    this.active = true;
  }

  async deactivate(): Promise<void> {
    this.active = false;
    await this.runJs(DEACTIVATE_SCRIPT).catch(() => {});
  }

  dispose() {
    if (!this.listening) return;
    this.listening = false;
    try {
      this.view.webContents.debugger.removeListener("message", this.onMessage);
    } catch {}
  }

  private receive(message: GrabMessage) {
    if (message.type === "active") {
      if (!message.active) this.active = false;
      return;
    }
    if (message.type === "selected") {
      if (!this.active) return;
      this.active = false;
      this.hooks.selected(message.content, message.region ?? null);
      void this.deactivate();
    }
  }
}
