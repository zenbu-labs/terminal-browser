import { useEffect, useRef, useState } from "react";
import { Box, Text, WebView } from "@zenbu-labs/pixel";
import type { WebViewHandle } from "@zenbu-labs/pixel";
import { Icon } from "./icons";
import { ignoreContextMenu } from "./extension-popup";
import type { Theme } from "./theme";
import type { ExtensionActions, ExtensionSidePanelView } from "./extension-types";
import type { ChromeLayout } from "./types";

const DIVIDER_ACTIVE = [58, 96, 168, 255] as const;
const DIVIDER_GRIP = [118, 122, 132, 255] as const;

type Rect = { x: number; y: number; width: number; height: number };

// Every live side panel page stays mounted so a hidden tab-specific panel
// keeps its state; only the showing one is visible, docked right of the page.
export function SidePanels({
  showing,
  panels,
  layout,
  theme,
  actions,
}: {
  showing: ExtensionSidePanelView | null;
  panels: ExtensionSidePanelView[];
  layout: ChromeLayout;
  theme: Theme;
  actions: ExtensionActions;
}) {
  const visible = showing && layout.sidePanel ? layout.sidePanel : null;
  const lastRect = useRef<Rect | null>(null);
  if (visible) lastRect.current = visible;
  const rect = visible ?? lastRect.current ?? layout.page;
  const rem = layout.rem;
  const headerH = Math.round(rem * 1.9);
  return (
    <>
      {visible && showing && <PanelFrame rect={visible} name={showing.name} headerH={headerH} layout={layout} theme={theme} actions={actions} />}
      {panels.map((panel) => (
        <PanelPage
          key={panel.key}
          panel={panel}
          hidden={!visible || panel.key !== showing?.key}
          rect={{ x: rect.x, y: rect.y + headerH, width: rect.width, height: Math.max(1, rect.height - headerH) }}
          radius={layout.radius}
          theme={theme}
          actions={actions}
        />
      ))}
      {visible && <PanelDivider rect={visible} layout={layout} actions={actions} />}
    </>
  );
}

function PanelFrame({
  rect,
  name,
  headerH,
  layout,
  theme,
  actions,
}: {
  rect: Rect;
  name: string;
  headerH: number;
  layout: ChromeLayout;
  theme: Theme;
  actions: ExtensionActions;
}) {
  const { rem, frame, radius } = layout;
  const close = Math.round(rem * 1.3);
  const padding = { left: Math.round(rem * 0.8), right: Math.round(rem * 0.3) };
  const gap = Math.round(rem * 0.5);
  return (
    <>
      <Box
        style={{
          position: "absolute",
          inset: { top: rect.y - frame, left: rect.x - frame },
          width: rect.width + frame * 2,
          height: rect.height + frame * 2,
          cornerRadius: radius + frame,
          border: { width: frame, color: theme.frame },
        }}
      />
      <Box
        style={{
          position: "absolute",
          inset: { top: rect.y, left: rect.x },
          width: rect.width,
          height: rect.height,
          cornerRadius: radius,
          background: theme.overlay,
        }}
      />
      <Box
        style={{
          position: "absolute",
          inset: { top: rect.y, left: rect.x },
          width: rect.width,
          height: headerH,
          alignItems: "center",
          gap,
          padding,
          border: { bottom: [1, theme.hairline] },
        }}
      >
        <Text
          style={{
            width: Math.max(0, rect.width - padding.left - padding.right - gap - close),
            flexShrink: 0,
            fontSize: rem * 0.85,
            color: theme.fg,
            wrap: false,
            ellipsis: true,
            selectable: false,
          }}
        >
          {name}
        </Text>
        <Box
          style={{
            width: close,
            height: close,
            alignItems: "center",
            justifyContent: "center",
            cornerRadius: rem * 0.3,
            hoverBackground: theme.hover,
            flexShrink: 0,
          }}
          onClick={actions.sidePanelClose}
        >
          <Icon icon="close" size={rem * 0.75} color={theme.muted} />
        </Box>
      </Box>
    </>
  );
}

function PanelPage({
  panel,
  hidden,
  rect,
  radius,
  theme,
  actions,
}: {
  panel: ExtensionSidePanelView;
  hidden: boolean;
  rect: Rect;
  radius: number;
  theme: Theme;
  actions: ExtensionActions;
}) {
  const view = useRef<WebViewHandle>(null);
  useEffect(() => {
    if (view.current) actions.sidePanelMounted(panel.key, view.current);
  }, [panel.key]);
  // A static panel page may never repaint after its first resize, leaving the
  // pre-resize frame stretched across the panel.
  useEffect(() => {
    if (hidden) return;
    const timer = setTimeout(() => view.current?.recording.invalidate(), 150);
    return () => clearTimeout(timer);
  }, [hidden, rect.width, rect.height]);
  return (
    <WebView
      ref={view}
      src={panel.url}
      hidden={hidden}
      autoFocus={false}
      devtools={false}
      onOpenWindow={actions.openWindow}
      onContextMenu={ignoreContextMenu}
      style={{
        position: "absolute",
        inset: { top: rect.y, left: rect.x },
        width: rect.width,
        height: rect.height,
        background: theme.overlay,
        cornerRadius: { topLeft: 0, topRight: 0, bottomLeft: radius, bottomRight: radius },
      }}
    />
  );
}

function PanelDivider({ rect, layout, actions }: { rect: Rect; layout: ChromeLayout; actions: ExtensionActions }) {
  const [hover, setHover] = useState(false);
  const [dragging, setDragging] = useState(false);
  const grab = Math.max(8, Math.round(layout.rem * 0.5));
  const engaged = hover || dragging;
  const divider = { x: rect.x - grab + 2 - layout.frame, y: rect.y, width: grab, height: rect.height };
  return (
    <Box
      style={{
        position: "absolute",
        inset: { top: divider.y, left: divider.x },
        width: divider.width,
        height: divider.height,
        cornerRadius: 2,
        background: dragging ? [...DIVIDER_ACTIVE] : undefined,
        pointerShape: "ew-resize",
      }}
      onDrag={(event) => {
        if (event.phase === "start") setDragging(true);
        if (event.phase === "end") setDragging(false);
        actions.sidePanelDividerDrag(event);
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {engaged &&
        [-7, 0, 7].map((offset) => (
          <Box
            key={offset}
            style={{
              position: "absolute",
              inset: { top: Math.round(divider.height / 2) + offset - 1, left: Math.round(divider.width / 2) - 1 },
              width: 2,
              height: 2,
              cornerRadius: 1,
              background: dragging ? [235, 238, 245, 255] : [...DIVIDER_GRIP],
            }}
          />
        ))}
    </Box>
  );
}
