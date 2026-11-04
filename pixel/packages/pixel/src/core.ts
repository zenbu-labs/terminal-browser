import { createElement, type ReactNode } from "react";

import { createEngineRoot } from "./react/core";
import type { NativeEngine } from "./react/native";
import type { PixelRoot, RootOptions, RootPlatform } from "./react/core";
import { RootContext, ViewRegistry } from "./registry";

export { setBinding } from "./react/binding";
export type { NativeBinding } from "./react/binding";
export type { NativeEngine } from "./react/native";
export * from "./react/core";
export { useRect } from "./layout";
export { makeTheme } from "./theme";
export type { Theme } from "./theme";

export interface CoreRootOptions extends Omit<RootOptions, "tty" | "host" | "wrapper" | "sessionEnv" | "cwd" | "engine"> {
  engine: NativeEngine;
  displayScale?: number;
}

export interface CoreRoot extends PixelRoot {
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

// fixme: placeholder copy
/** A root for hosts that bring their own engine and have no node, like an iOS app. */
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
