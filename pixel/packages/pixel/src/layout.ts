import { useContext, useEffect, useLayoutEffect, useState } from "react";
import type { RefObject } from "react";

import { debug } from "./debug";
import type { LayoutSnapshot } from "./react";
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
  const [rect, setRect] = useState<Rect | null>(null);
  // subscribed before the query below goes out, or the reply can land first and be missed
  useLayoutEffect(
    () =>
      registry.layout.subscribe(() => {
        const id = node.current?.id;
        const snapshot = registry.layout.get();
        debug("layout reply", { id, nodes: snapshot.rects.size, found: id != null ? snapshot.rects.get(id) : null });
        if (id == null) return;
        const found = snapshot.rects.get(id);
        if (!found) return;
        setRect((prev) =>
          prev &&
          prev.x === found.x &&
          prev.y === found.y &&
          prev.width === found.w &&
          prev.height === found.h
            ? prev
            : { x: found.x, y: found.y, width: found.w, height: found.h },
        );
      }),
    [node, registry],
  );
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
