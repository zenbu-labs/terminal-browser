import type { ReactNode } from "react";

import { createEngineRoot } from "../react";
import type { PixelRoot, RootOptions, RootPlatform } from "../react";
import { RootContext, ViewRegistry } from "../registry";

export type DeviceRootOptions = Omit<RootOptions, "tty" | "host" | "wrapper" | "sessionEnv" | "devtools" | "cwd"> & {
  displayScale?: number;
};

export interface DeviceRoot extends PixelRoot {
  displayScale: number;
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
  const { displayScale = 1, ...rest } = options;
  let registry: ViewRegistry | null = null;
  const engine = createEngineRoot(
    {
      ...rest,
      devtools: false,
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
    render(element: ReactNode) {
      engine.render(<RootContext.Provider value={views}>{element}</RootContext.Provider>);
    },
  };
}
