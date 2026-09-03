import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { bundledAsset } from "../assets";
import type { BrowserController } from "../page/controller";

const CHANNEL = "grab";
const PLUGIN = "terminal-browser";
const SCRIPT_ASSET = "react-grab/index.global.js";

let librarySource: string | null = null;
function reactGrabLibrary(): string {
  if (librarySource) return librarySource;
  const file = bundledAsset(SCRIPT_ASSET) ?? require.resolve("react-grab/dist/index.global.js");
  librarySource = `${fs.readFileSync(file, "utf8")}\n;undefined;`;
  return librarySource;
}

const REGISTER_PLUGIN = `(api) => {
  const emit = (data) => window.__pixelEmit?.(JSON.stringify({ channel: ${JSON.stringify(CHANNEL)}, data }));
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
      transformCopyContent: (content) => {
        emit({ type: "selected", content });
        api.reset();
        api.deactivate();
        return content;
      },
    },
  });
}`;

let preloadFile: string | null = null;
export function reactGrabPreloadPath(): string {
  if (!preloadFile) {
    const early = `window.__REACT_GRAB_DISABLED__ = true;\n${reactGrabLibrary()}`;
    preloadFile = path.join(app.getPath("userData"), "terminal-browser-react-grab-preload.js");
    fs.writeFileSync(
      preloadFile,
      `if (process.isMainFrame && !process.argv.some((arg) => arg.startsWith("--terminal-browser-app-tab="))) {
  const { webFrame } = require("electron");
  void webFrame.executeJavaScript(${JSON.stringify(early)});
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

type GrabMessage =
  | { type: "active"; active: boolean }
  | { type: "selected"; content: string };

export interface GrabHooks {
  selected(content: string): void;
}

export class Grab {
  active = false;

  constructor(
    private readonly controller: BrowserController,
    private readonly hooks: GrabHooks,
  ) {
    controller.onEmit(CHANNEL, (data) => this.receive(data as GrabMessage));
    controller.onCdpEvent("Page.frameNavigated", (params) => {
      const frame = (params as { frame?: { parentId?: string } }).frame;
      const mainFrameNavigated = !frame?.parentId;
      if (mainFrameNavigated) this.active = false;
    });
  }

  async activate(): Promise<void> {
    await this.controller.attachCdp();
    const loaded = await this.controller.runJs("Boolean(window.__REACT_GRAB__)");
    if (!loaded) await this.controller.runJs(reactGrabLibrary());
    const result = await this.controller.runJs(ACTIVATE_SCRIPT);
    if (result !== "active") {
      throw new Error("react-grab failed to start");
    }
    this.active = true;
  }

  async deactivate(): Promise<void> {
    this.active = false;
    await this.controller.runJs(DEACTIVATE_SCRIPT).catch(() => {});
  }

  dispose() {
    this.controller.onEmit(CHANNEL, null);
    this.controller.onCdpEvent("Page.frameNavigated", null);
  }

  private receive(message: GrabMessage) {
    if (message.type === "active") {
      this.active = message.active;
      return;
    }
    if (message.type === "selected") {
      this.hooks.selected(message.content);
      void this.deactivate();
    }
  }
}
