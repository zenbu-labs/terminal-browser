import { useEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { Box } from "@zenbu-labs/pixel";
import type { NodeHandle, Style } from "@zenbu-labs/pixel";

const WHEEL_TICK_REMS = 2.5;

// Wheel events go to the page under the card, not to a scroll box painted over it,
// so this box listens for the wheel itself and moves its own offset.
export function ScrollPane({
  style,
  rem,
  resetKey,
  paneRef,
  children,
}: {
  style: Style;
  rem: number;
  resetKey: number;
  paneRef?: RefObject<NodeHandle | null>;
  children: ReactNode;
}) {
  const box = useRef<NodeHandle | null>(null);
  const target = useRef(0);
  const max = useRef(Infinity);
  useEffect(() => {
    target.current = 0;
    max.current = Infinity;
    box.current?.scrollTo(0);
  }, [resetKey]);
  return (
    <Box
      ref={(node: NodeHandle | null) => {
        box.current = node;
        if (paneRef) (paneRef as { current: NodeHandle | null }).current = node;
      }}
      style={{ ...style, overflow: "scroll" }}
      onScroll={(event) => {
        max.current = event.max;
        target.current = Math.min(target.current, event.max);
      }}
      onWheel={(event) => {
        if (event.mods.ctrl) return;
        const delta = event.precise
          ? event.deltaY
          : Math.sign(event.deltaY) * rem * WHEEL_TICK_REMS;
        target.current = Math.min(Math.max(0, target.current + delta), max.current);
        box.current?.scrollTo(target.current, !event.precise);
      }}
    >
      {children}
    </Box>
  );
}
