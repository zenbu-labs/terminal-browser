import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import type { Rect } from "./devtools-layout";
import { useNodeRect } from "./layout";
import { Box } from "./react";
import type { DragEvent, NodeHandle, PointerEvent, PointerShape, Style, Surface, WheelEvent } from "./react";
import { RootContext, handleEntries } from "./registry";
import type { ViewEntry } from "./registry";
import type { Theme } from "./theme";
import type { DevtoolsWindow } from "./web/devtools";
import { snapToCssGrid } from "./web/types";
import type { DevtoolsDock } from "./web/types";
import type { WebViewHandle } from "./webview";

const DIVIDER_ACTIVE = [58, 96, 168, 255] as const;
const DIVIDER_GRIP = [118, 122, 132, 255] as const;

export function DevtoolsDockPane({
  rect,
  dock,
  rem,
  theme,
  surface,
  dividerEngaged,
  pointerShape,
  onPointer,
  onWheel,
  onDividerDrag,
}: {
  rect: Rect;
  dock: DevtoolsDock;
  rem: number;
  theme: Theme;
  surface: Surface;
  dividerEngaged: boolean;
  pointerShape: PointerShape;
  onPointer(event: PointerEvent): void;
  onWheel(event: WheelEvent): void;
  onDividerDrag(event: DragEvent): void;
}) {
  const horizontal = dock === "bottom";
  const grab = Math.max(8, Math.round(rem * 0.5));
  const divider = horizontal
    ? { x: rect.x, y: rect.y - grab + 2, width: rect.width, height: grab }
    : { x: rect.x - grab + 2, y: rect.y, width: grab, height: rect.height };
  const gripAlong = (offset: number) =>
    horizontal
      ? { top: Math.round(divider.height / 2) - 1, left: Math.round(divider.width / 2) + offset - 1 }
      : { top: Math.round(divider.height / 2) + offset - 1, left: Math.round(divider.width / 2) - 1 };
  return (
    <>
      <Box
        surface={surface}
        style={{
          position: "absolute",
          inset: { top: rect.y, left: rect.x },
          width: rect.width,
          height: rect.height,
          background: theme.bg,
          pointerShape,
        }}
        onPointer={onPointer}
        onWheel={onWheel}
      />
      <Box
        style={{
          position: "absolute",
          inset: { top: divider.y, left: divider.x },
          width: divider.width,
          height: divider.height,
          background: dividerEngaged ? [...DIVIDER_ACTIVE] : undefined,
          cornerRadius: 2,
          pointerShape: horizontal ? "ns-resize" : "ew-resize",
        }}
        onDrag={onDividerDrag}
      >
        {[-7, 0, 7].map((offset) => (
          <Box
            key={offset}
            style={{
              position: "absolute",
              inset: gripAlong(offset),
              width: 2,
              height: 2,
              cornerRadius: 1,
              background: dividerEngaged ? [235, 238, 245, 255] : [...DIVIDER_GRIP],
            }}
          />
        ))}
      </Box>
    </>
  );
}

export interface DevToolsProps {
  target: RefObject<WebViewHandle | null> | WebViewHandle;
  style?: Style;
  dock?: DevtoolsDock;
  panel?: string;
  onAction?(action: "close" | "dock-bottom" | "dock-right"): void;
  keepFrame?: boolean;
}

function resolveEntry(target: DevToolsProps["target"]): ViewEntry | null {
  const handle = "current" in target ? target.current : target;
  return handle ? handleEntries.get(handle) ?? null : null;
}

export function DevTools({ target, style, dock = "right", panel, onAction, keepFrame = true }: DevToolsProps) {
  const registry = useContext(RootContext);
  if (!registry) {
    throw new Error(
      "<DevTools> has to be rendered by a root from createRoot()",
    );
  }
  const boxRef = useRef<NodeHandle>(null);
  const rect = useNodeRect(boxRef, registry);
  const surface = useRef<Surface | null>(null);
  const opened = useRef<ViewEntry | null>(null);
  const [pointerShape, setPointerShape] = useState<PointerShape>("default");
  const scale = registry.displayScale;

  useLayoutEffect(() => {
    surface.current = registry.root.createSurface();
    return () => {
      const entry = opened.current;
      if (entry?.externalDevtools) {
        entry.externalDevtools = false;
        entry.externalDevtoolsAction = null;
        entry.externalDevtoolsCursor = null;
        entry.host?.closeDevtools();
      }
      opened.current = null;
      surface.current?.close();
      surface.current = null;
    };
  }, [registry]);

  const size = rect ? snapToCssGrid(rect.width, rect.height, scale) : null;

  useEffect(() => {
    const entry = resolveEntry(target);
    const host = entry?.host;
    if (!entry || !host || !size || !surface.current) return;
    const layout = { x: 0, y: 0, width: size.width, height: size.height, scale };
    if (opened.current !== entry && opened.current?.externalDevtools) {
      opened.current.externalDevtools = false;
      opened.current.host?.closeDevtools();
    }
    if (opened.current !== entry) {
      if (opened.current) opened.current.externalDevtoolsCursor = null;
      setPointerShape(host.devtools?.cursorShape ?? "default");
    }
    opened.current = entry;
    entry.externalDevtoolsAction = (action) => onAction?.(action);
    entry.externalDevtoolsCursor = setPointerShape;
    if (!host.devtools) {
      entry.externalDevtools = true;
      host.openDevtools(surface.current, layout, dock);
      const opened = (): DevtoolsWindow | null => host.devtools;
      if (panel) opened()?.showPanel(panel);
      return;
    }
    if (entry.externalDevtools) host.devtools.resize(layout, { keepFrame });
  });
  useEffect(() => {
    const host = resolveEntry(target)?.host;
    if (panel && host?.devtools) host.devtools.showPanel(panel);
  }, [panel, target]);
  useEffect(() => {
    resolveEntry(target)?.host?.devtools?.setDock(dock);
  }, [dock, target]);

  const entry = resolveEntry(target);
  return (
    <Box ref={boxRef} style={{ ...style, overflow: "hidden" }}>
      {size && surface.current && (
        <Box
          surface={surface.current}
          style={{
            position: "absolute",
            inset: { top: 0, left: 0 },
            width: size.width,
            height: size.height,
            cornerRadius: style?.cornerRadius,
            pointerShape,
          }}
          onPointer={(event) => {
            const host = entry?.host;
            if (!entry || !host?.devtools) return;
            registry.focus(entry, "devtools");
            host.devtools.input.pointer(event);
          }}
          onWheel={(event) => {
            const host = entry?.host;
            if (!entry || !host?.devtools) return;
            registry.focus(entry, "devtools");
            host.devtools.input.wheel(event);
          }}
        />
      )}
    </Box>
  );
}
