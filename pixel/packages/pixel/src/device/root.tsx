import type { ReactNode } from "react";

import { createEngineRoot } from "../react";
import type { EngineKeyEvent, PixelRoot, RootOptions, RootPlatform, TapEvent } from "../react";
import { RootContext, ViewRegistry } from "../registry";

export type DeviceRootOptions = Omit<RootOptions, "tty" | "host" | "wrapper" | "sessionEnv" | "devtools" | "cwd" | "onKey"> & {
  displayScale?: number;
  onKey?: (event: EngineKeyEvent) => boolean | void;
};

export interface DeviceRoot extends PixelRoot {
  displayScale: number;
  hostKey(event: EngineKeyEvent): boolean;
  hostTap(event: TapEvent): void;
  showKeyboard(visible: boolean): void;
  haptic(style: HapticStyle): void;
}

export type HapticStyle = "selection" | "success" | "error" | "light" | "medium" | "heavy";

function request(root: PixelRoot, body: string) {
  root.writeTerminal(`\x1b]7717;${body}\x07`);
}

const devicePlatform: RootPlatform = {
  installConsoleCapture() {},
  setProfileDirectory() {},
  exportProfile: () => null,
  requestFrameRate() {},
  onTerminalResize: () => () => {},
  onProcessExit: () => () => {},
  exitWithEngine(error) {
    if (error) console.error(`pixel engine exited: ${error}`);
  },
};

export function createRoot(options: DeviceRootOptions = {}): DeviceRoot {
  const { displayScale = 1, onKey, ...rest } = options;
  let registry: ViewRegistry | null = null;
  const engine = createEngineRoot(
    {
      ...rest,
      devtools: false,
      onKey: (event) => void onKey?.(event),
      onLayout(snapshot) {
        registry?.layout.set(snapshot);
        rest.onLayout?.(snapshot);
      },
      onColors(colors) {
        registry?.colors.set(colors);
        rest.onColors?.(colors);
      },
      onResize(size) {
        if (registry) for (const listener of registry.resizeListeners) listener();
        rest.onResize?.(size);
      },
    },
    devicePlatform,
  );
  const views = new ViewRegistry(engine, displayScale, false, { quit: () => {} });
  registry = views;
  return {
    ...engine,
    displayScale,
    hostKey: (event) => onKey?.(event) === true,
    hostTap: (event) => rest.onTap?.(event),
    showKeyboard: (visible) => request(engine, `keyboard=${visible ? "show" : "hide"}`),
    haptic: (style) => request(engine, `haptic=${style}`),
    render(element: ReactNode) {
      engine.render(<RootContext.Provider value={views}>{element}</RootContext.Provider>);
    },
  };
}
