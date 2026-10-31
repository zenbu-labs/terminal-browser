import { requireNativeModule } from "expo-modules-core";
import { useEffect, useRef, useState } from "react";
import { surfaceId } from "@zenbu-labs/pixel/device";
import type { DeviceRoot } from "@zenbu-labs/pixel/device";

interface NativeViewsModule {
  open(id: number, kind: string): void;
  configure(id: number, json: string): void;
  close(id: number): void;
  addListener(event: "onNativeViewEvent", listener: (event: NativeViewEvent) => void): { remove(): void };
}

export interface NativeViewEvent {
  id: number;
  type: string;
  [key: string]: unknown;
}

const NativeViews = requireNativeModule<NativeViewsModule>("PixelNativeViews");
const listeners = new Map<number, (event: NativeViewEvent) => void>();
let subscribed = false;

function listen(id: number, listener: (event: NativeViewEvent) => void) {
  if (!subscribed) {
    subscribed = true;
    NativeViews.addListener("onNativeViewEvent", (event) => listeners.get(event.id)?.(event));
  }
  listeners.set(id, listener);
  return () => void listeners.delete(id);
}

export function useNativeView(root: DeviceRoot, kind: string, onEvent: (event: NativeViewEvent) => void) {
  const [surface] = useState(() => root.createSurface());
  const id = surfaceId(surface);
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    NativeViews.open(id, kind);
    const stop = listen(id, (event) => handler.current(event));
    return () => {
      stop();
      NativeViews.close(id);
    };
  }, [id, kind]);
  const configure = (config: Record<string, unknown>) => NativeViews.configure(id, JSON.stringify(config));
  return { surface, id, configure };
}
