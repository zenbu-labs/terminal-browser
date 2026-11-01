import { createContext, useContext, useSyncExternalStore } from "react";

export interface SafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const NONE: SafeArea = { top: 0, right: 0, bottom: 0, left: 0 };
const INSETS = "7717;insets=";

export function createSafeArea() {
  let current = NONE;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    accept(data: string): boolean {
      if (!data.startsWith(INSETS)) return false;
      const [top = 0, right = 0, bottom = 0, left = 0] = data.slice(INSETS.length).split(",").map(Number);
      current = { top, right, bottom, left };
      for (const listener of listeners) listener();
      return true;
    },
  };
}

export const SafeAreaContext = createContext<ReturnType<typeof createSafeArea> | null>(null);

export function useSafeArea(): SafeArea {
  const store = useContext(SafeAreaContext);
  return useSyncExternalStore(store?.subscribe ?? (() => () => {}), store?.get ?? (() => NONE));
}
