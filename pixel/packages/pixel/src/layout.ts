import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { RefObject } from "react";

import type { NodeHandle } from "./react";
import { RootContext } from "./registry";
import type { ViewRegistry } from "./registry";
import type { Rect } from "./devtools-layout";

export function useRect(node: RefObject<NodeHandle | null>): Rect | null {
  const registry = useContext(RootContext);
  if (!registry) {
    throw new Error("useRect has to be used under a root from createRoot()");
  }
  return useNodeRect(node, registry);
}


export function useNodeRect(node: RefObject<NodeHandle | null>, registry: ViewRegistry): Rect | null {
  const last = useRef<Rect | null>(null);
  const read = useCallback(() => {
    const id = node.current?.id;
    const found = id != null ? registry.layout.get().rects.get(id) : undefined;
    const prev = last.current;
    if (!found || (prev && prev.x === found.x && prev.y === found.y && prev.width === found.w && prev.height === found.h)) return prev;
    last.current = { x: found.x, y: found.y, width: found.w, height: found.h };
    return last.current;
  }, [node, registry]);
  const rect = useSyncExternalStore(registry.layout.subscribe, read);
  useLayoutEffect(() => {
    const watcher = () => node.current?.id;
    registry.rectWatchers.add(watcher);
    return () => {
      registry.rectWatchers.delete(watcher);
    };
  }, [node, registry]);
  useEffect(() => {
    const ask = () => registry.queryLayout();
    registry.resizeListeners.add(ask);
    return () => {
      registry.resizeListeners.delete(ask);
    };
  }, [registry]);
  return rect;
}
