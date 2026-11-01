// Runs in every frame of the browsing session but only exposes anything to the
// top frame of a terminal-browser:// page, and only that page's own calls. The
// main process checks the sender again. Sandboxed preloads can only require
// "electron", so this file must stay self-contained.
import { contextBridge, ipcRenderer } from "electron";

import { INTERNAL_API, INTERNAL_CHANGED_CHANNEL, internalChannel, isInternalHost } from "./internal-api";

const ERROR_PREFIX = /^Error invoking remote method '[^']*': (?:Error: )?/;

function expose() {
  if (location.protocol !== "terminal-browser:" || window.top !== window) return;
  const host = location.host;
  if (!isInternalHost(host)) return;
  const api: Record<string, unknown> = {};
  for (const method of INTERNAL_API[host]) {
    api[method] = (...args: unknown[]) =>
      ipcRenderer.invoke(internalChannel(host, method), ...args).catch((error: Error) => {
        throw new Error(String(error?.message ?? error).replace(ERROR_PREFIX, ""));
      });
  }
  api.onChange = (listener: () => void) => {
    ipcRenderer.on(INTERNAL_CHANGED_CHANNEL, () => listener());
  };
  contextBridge.exposeInMainWorld("terminalBrowser", api);
}

expose();
