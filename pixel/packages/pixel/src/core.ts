import { createElement, type ReactNode } from "react";

import { createEngineRoot } from "./react/core";
import type { NativeEngine } from "./react/native";
import type { EngineRoot, EngineRootOptions, RootPlatform } from "./react/core";
import { RootContext, ViewRegistry } from "./registry";

export { setBinding } from "./react/binding";
export type { NativeBinding } from "./react/binding";
export type { NativeEngine } from "./react/native";
export * from "./react/core";
export { useRect } from "./layout";
export { surfaceId } from "./react/surface";
export { makeTheme } from "./theme";
export type { Theme } from "./theme";

export interface CoreRootOptions extends Omit<EngineRootOptions, "tty" | "host" | "wrapper" | "sessionEnv" | "cwd" | "engine"> {
  engine: NativeEngine;
  displayScale?: number;
}

export interface CoreRoot extends EngineRoot {
  displayScale: number;
}

const hostedPlatform: RootPlatform = {
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

export function createRoot(options: CoreRootOptions): CoreRoot {
  const { displayScale = 1, ...rest } = options;
  let registry: ViewRegistry | null = null;
  const root = createEngineRoot(
    {
      devtools: false,
      ...rest,
      onLayout(snapshot) {
        registry?.layout.set(snapshot);
        rest.onLayout?.(snapshot);
      },
      // The nodes useRect watches are measured after every commit, as the terminal root does.
      layoutIds: () => registry?.watchedRects() ?? [],
      onColors(colors) {
        registry?.colors.set(colors);
        rest.onColors?.(colors);
      },
      onResize(size) {
        if (registry) for (const listener of registry.resizeListeners) listener();
        rest.onResize?.(size);
      },
    },
    hostedPlatform,
  );
  const views = new ViewRegistry(root, displayScale, false, { quit: () => {} });
  registry = views;
  return {
    ...root,
    displayScale,
    render(element: ReactNode) {
      root.render(createElement(RootContext.Provider, { value: views }, element));
    },
  };
}
