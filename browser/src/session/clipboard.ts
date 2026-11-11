import { clipboard } from "electron";
import type { WebViewHandle } from "@zenbu-labs/pixel";

const CLIPBOARD_BINDING = "__terminalBrowserClipboard";
const CLIPBOARD_API_BINDING = "__terminalBrowserClipboardApiWrite";
const CLIPBOARD_WORLD_ID = 1013;
const CLIPBOARD_WORLD = "terminal-browser-clipboard";

const CLIPBOARD_API_WATCHER = `;(() => {
  const clipboard = navigator.clipboard;
  if (!clipboard) return;
  for (const method of ["writeText", "write"]) {
    const original = clipboard[method];
    if (typeof original !== "function") continue;
    Object.defineProperty(clipboard, method, {
      configurable: true,
      writable: true,
      value: async function(...args) {
        const result = await Reflect.apply(original, this, args);
        try {
          let text;
          if (method === "writeText") {
            text = String(args[0]);
          } else {
            for (const item of args[0]) {
              if (item.types.includes("text/plain")) {
                text = await (await item.getType("text/plain")).text();
                break;
              }
            }
          }
          if (text && typeof window.${CLIPBOARD_API_BINDING} === "function") {
            window.${CLIPBOARD_API_BINDING}(text);
          }
        } catch {}
        return result;
      },
    });
  }
})();`;

const CLIPBOARD_EVENTS_WATCHER = `;(() => {
  for (const type of ["copy", "cut"]) {
    document.addEventListener(type, (event) => {
      if (!event.isTrusted) return;
      // Chromium clears clipboardData after the event has been dispatched.
      const text = event.clipboardData?.getData("text/plain");
      if (text && typeof window.${CLIPBOARD_BINDING} === "function") {
        window.${CLIPBOARD_BINDING}(text);
      }
    });
  }
})();`;

const COPY_ON_SELECT_WATCHER = `;(() => {
  let last = "";
  document.addEventListener("mouseup", (event) => {
    if (!event.isTrusted) return;
    setTimeout(() => {
      const selection = window.getSelection && window.getSelection();
      const text = selection ? String(selection).trim() : "";
      if (text && text !== last && typeof window.${CLIPBOARD_BINDING} === "function") {
        last = text;
        window.${CLIPBOARD_BINDING}(text);
      }
    }, 0);
  });
})();`;

const READ_CLIPBOARD = `(async () => {
  try {
    const permission = await navigator.permissions.query({ name: "clipboard-read" });
    if (permission.state !== "granted") return null;
    return await navigator.clipboard.readText();
  } catch { return null; }
})()`;

export function clipboardPreload(copyOnSelect: boolean): string {
  const events = CLIPBOARD_EVENTS_WATCHER + (copyOnSelect ? COPY_ON_SELECT_WATCHER : "");
  return `
  void webFrame.executeJavaScript(${JSON.stringify(CLIPBOARD_API_WATCHER)});
  webFrame.setIsolatedWorldInfo(${CLIPBOARD_WORLD_ID}, { name: ${JSON.stringify(CLIPBOARD_WORLD)} });
  void webFrame.executeJavaScriptInIsolatedWorld(${CLIPBOARD_WORLD_ID}, [{ code: ${JSON.stringify(events)} }]);`;
}

export class PageClipboard {
  private listening = false;
  private sequence = 0;
  private readonly onMessage = (_event: unknown, method: string, params: unknown) => {
    if (method === "Runtime.executionContextsCleared" || method === "Page.frameNavigated") {
      if (method === "Page.frameNavigated") {
        const frame = (params as { frame?: { parentId?: string } }).frame;
        if (frame?.parentId) return;
      }
      this.sequence++;
      return;
    }
    if (method !== "Runtime.bindingCalled") return;
    const call = params as { name: string; payload: string };
    if (call.name !== CLIPBOARD_BINDING && call.name !== CLIPBOARD_API_BINDING) return;
    if (typeof call.payload !== "string" || !call.payload || !this.hooks.active()) return;
    const sequence = ++this.sequence;
    if (call.name === CLIPBOARD_BINDING) this.copy(call.payload, sequence);
    else void this.forwardClipboardApiWrite(call.payload, sequence);
  };

  constructor(
    private readonly view: WebViewHandle,
    private readonly hooks: { copied(text: string): void; active(): boolean },
  ) {}

  async enable(): Promise<void> {
    if (this.listening) return;
    this.listening = true;
    this.view.webContents.debugger.on("message", this.onMessage);
    try {
      await Promise.all([
        this.view.cdp("Runtime.addBinding", {
          name: CLIPBOARD_BINDING,
          executionContextName: CLIPBOARD_WORLD,
        }),
        this.view.cdp("Runtime.addBinding", { name: CLIPBOARD_API_BINDING }),
      ]);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  dispose(): void {
    this.listening = false;
    this.sequence++;
    try {
      this.view.webContents.debugger.removeListener("message", this.onMessage);
    } catch {}
  }

  private copy(text: string, sequence: number): void {
    if (this.listening && sequence === this.sequence && this.hooks.active()) this.hooks.copied(text);
  }

  private async forwardClipboardApiWrite(text: string, sequence: number): Promise<void> {
    let actual: unknown;
    try {
      actual = await clipboard.readText();
    } catch {}
    if (actual !== text) {
      try {
        actual = await this.view.webContents.executeJavaScriptInIsolatedWorld(CLIPBOARD_WORLD_ID, [
          { code: READ_CLIPBOARD },
        ]);
      } catch {}
    }
    if (actual === text) this.copy(text, sequence);
  }
}
