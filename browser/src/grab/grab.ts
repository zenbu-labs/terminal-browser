import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { WebViewHandle } from "@zenbu-labs/pixel";
import { bundledAsset } from "../assets";
import { clipboardPreload } from "../session/clipboard";

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
    style.textContent = "[data-react-grab-completion] { display: none !important; }";
    overlay.appendChild(style);
  }
  if (api.getPlugins().includes(${JSON.stringify(PLUGIN)})) return;
  api.registerPlugin({
    name: ${JSON.stringify(PLUGIN)},
    theme: { toolbar: { enabled: false } },
    hooks: {
      onActivate: () => emit({ type: "active", active: true }),
      onDeactivate: () => emit({ type: "active", active: false }),
      transformCopyContent: (content, elements) => {
        emit({ type: "selected", content, region: regionAround(elements) });
        api.reset();
        api.deactivate();
        return content;
      },
    },
  });
}`;

let preloadFile: string | null = null;
export function reactGrabPreloadPath(copyOnSelect = false): string {
  if (!preloadFile) {
    const early = `window.__REACT_GRAB_DISABLED__ = true;\n${reactGrabLibrary()}`;
    preloadFile = path.join(app.getPath("userData"), "terminal-browser-react-grab-preload.js");
    fs.writeFileSync(
      preloadFile,
      `if (process.isMainFrame) {
  const { webFrame } = require("electron");
  void webFrame.executeJavaScript(${JSON.stringify(early)});${clipboardPreload(copyOnSelect)}
}
`,
    );
  }
  return preloadFile;
}

const ACTIVATE_SCRIPT = `(() => {
  const api = (window.__REACT_GRAB__ ??= globalThis.__REACT_GRAB_MODULE__?.init({ telemetry: false }));
  if (!api) return "missing";
  (${REGISTER_PLUGIN})(api);
  api.activate();
  return "active";
})()`;

const DEACTIVATE_SCRIPT = "window.__REACT_GRAB__?.deactivate()";

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

  async activate(): Promise<void> {
    await this.listen();
    const loaded = await this.runJs("Boolean(window.__REACT_GRAB__)");
    if (!loaded) await this.runJs(reactGrabLibrary());
    const result = await this.runJs(ACTIVATE_SCRIPT);
    if (result !== "active") {
      throw new Error("react-grab failed to start");
    }
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
