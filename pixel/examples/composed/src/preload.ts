import { contextBridge } from "electron";
import type { TerminalTheme } from "@zenbu-labs/pixel/preload";

contextBridge.exposeInMainWorld("pixel", {
  theme: () => pixel.theme(),
  onTheme: (subscriber: (theme: TerminalTheme) => void) => pixel.onTheme(subscriber),
  quit: () => pixel.quit(),
});
