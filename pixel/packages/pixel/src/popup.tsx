import { useState } from "react";

import { Box, Text } from "./react";
import type { PointerEvent, PointerShape, Surface, WheelEvent } from "./react";
import { Icon } from "./icons";
import type { Theme } from "./theme";
import type { Rect } from "./devtools-layout";

export interface PopupView {
  title: string;
  host: string;
  loading: boolean;
  width: number;
  height: number;
}

export function PopupCard({
  view,
  page,
  rem,
  theme,
  surface,
  pointerShape,
  onPointer,
  onWheel,
  onClose,
}: {
  view: PopupView;
  page: Rect;
  rem: number;
  theme: Theme;
  surface: Surface;
  pointerShape: PointerShape;
  onPointer(event: PointerEvent): void;
  onWheel(event: WheelEvent): void;
  onClose(): void;
}) {
  const [closeHover, setCloseHover] = useState(false);
  const headerH = Math.round(rem * 1.7);
  const cardH = headerH + view.height;
  const left = page.x + Math.round((page.width - view.width) / 2);
  const top = page.y + Math.max(Math.round(rem * 0.5), Math.round((page.height - cardH) / 2));
  return (
    <>
      <Box
        style={{
          position: "absolute",
          inset: { top: page.y, left: page.x },
          width: page.width,
          height: page.height,
          background: [8, 9, 12, 150],
        }}
        onPointer={(event) => {
          if (event.kind === "down") onClose();
        }}
        onWheel={() => {}}
      />
      <Box
        style={{
          position: "absolute",
          inset: { top, left },
          width: view.width,
          flexDirection: "column",
          background: theme.bg,
          cornerRadius: rem * 0.5,
          border: { width: 1, color: theme.fieldBorder },
          overflow: "hidden",
        }}
        onPointer={() => {}}
        onWheel={() => {}}
      >
        <Box
          style={{
            height: headerH,
            alignItems: "center",
            gap: rem * 0.5,
            padding: { left: rem * 0.65, right: rem * 0.35 },
            background: theme.field,
            border: { bottom: [1, theme.hairline] },
          }}
        >
          <Text style={{ fontSize: rem * 0.78, wrap: false, selectable: false }}>
            {view.title || (view.loading ? "loading…" : view.host)}
          </Text>
          <Box style={{ flexGrow: 1, flexBasis: 0 }} />
          <Text style={{ fontSize: rem * 0.72, color: theme.muted, wrap: false, selectable: false }}>
            {view.host}
          </Text>
          <Box
            style={{
              width: rem * 1.15,
              height: rem * 1.15,
              alignItems: "center",
              justifyContent: "center",
              cornerRadius: rem * 0.3,
              background: closeHover ? theme.hover : undefined,
            }}
            onClick={onClose}
            onMouseEnter={() => setCloseHover(true)}
            onMouseLeave={() => setCloseHover(false)}
          >
            <Icon icon="close" size={rem * 0.8} color={theme.muted} />
          </Box>
        </Box>
        <Box
          surface={surface}
          style={{ width: view.width, height: view.height, background: theme.bg, pointerShape }}
          onPointer={onPointer}
          onWheel={onWheel}
        />
      </Box>
    </>
  );
}
