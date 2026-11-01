import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { Box, Image, Text, useRect } from "@zenbu-labs/pixel";
import type { NodeHandle, PointerEvent, Rgba } from "@zenbu-labs/pixel";
import { Icon } from "./icons";
import { withAlpha } from "./theme";
import type { Theme } from "./theme";
import type { ExtensionActions, ExtensionsView, ToolbarAction } from "./extension-types";

function setRef(ref: RefObject<NodeHandle | null>, node: NodeHandle | null) {
  (ref as { current: NodeHandle | null }).current = node;
}

const slot = (rem: number) => rem * 1.5;
const gap = (rem: number) => rem * 0.25;

// Which actions sit on the toolbar: pinned ones plus the one whose popup is
// open, as many as fit in `room`; the rest live in the extensions menu.
export function toolbarActions(view: ExtensionsView | null, rem: number, room: number): { shown: ToolbarAction[]; width: number } {
  if (!view || !view.onToolbar || view.actions.length === 0) return { shown: [], width: 0 };
  const step = slot(rem) + gap(rem);
  const fits = Math.max(0, Math.floor((room - step) / step));
  const wanted = view.actions.filter((action) => action.pinned || action.extensionId === view.popup?.extensionId);
  const shown = wanted.slice(0, fits);
  const popupId = view.popup?.extensionId;
  if (popupId && fits > 0 && !shown.some((action) => action.extensionId === popupId)) {
    shown[shown.length - 1] = wanted.find((action) => action.extensionId === popupId)!;
  }
  return { shown, width: (shown.length + 1) * step };
}

export interface TooltipView {
  text: string;
  x: number;
  y: number;
}

export function ExtensionToolbar({
  view,
  shown,
  actions,
  anchor,
  puzzle,
  onTooltip,
  rem,
  theme,
}: {
  view: ExtensionsView;
  shown: ToolbarAction[];
  actions: ExtensionActions;
  anchor: RefObject<NodeHandle | null>;
  puzzle: RefObject<NodeHandle | null>;
  onTooltip(tip: TooltipView | null): void;
  rem: number;
  theme: Theme;
}) {
  const popupId = view.popup?.extensionId ?? null;
  const anchoredToIcon = shown.some((action) => action.extensionId === popupId);
  return (
    <Box style={{ alignItems: "center", gap: gap(rem), flexShrink: 0 }}>
      {shown.map((action) => (
        <ActionButton
          key={action.extensionId}
          action={action}
          open={action.extensionId === popupId}
          anchor={action.extensionId === popupId ? anchor : null}
          actions={actions}
          onTooltip={onTooltip}
          rem={rem}
          theme={theme}
        />
      ))}
      <Box
        ref={(node: NodeHandle | null) => {
          setRef(puzzle, node);
          if (popupId && !anchoredToIcon) setRef(anchor, node);
        }}
        style={{
          width: slot(rem),
          height: slot(rem),
          alignItems: "center",
          justifyContent: "center",
          cornerRadius: rem * 0.3,
          background: view.menuOpen || (popupId && !anchoredToIcon) ? theme.hover : undefined,
          hoverBackground: theme.hover,
          flexShrink: 0,
        }}
        onClick={actions.toggleMenu}
      >
        <Icon icon="puzzle" size={rem * 1.05} color={theme.muted} weight={2} />
      </Box>
    </Box>
  );
}

function ActionButton({
  action,
  open,
  anchor,
  actions,
  onTooltip,
  rem,
  theme,
}: {
  action: ToolbarAction;
  open: boolean;
  anchor: RefObject<NodeHandle | null> | null;
  actions: ExtensionActions;
  onTooltip(tip: TooltipView | null): void;
  rem: number;
  theme: Theme;
}) {
  const own = useRef<NodeHandle | null>(null);
  const rect = useRect(own);
  const tooltip = useHoverDelay(open);
  const tipText = action.title || action.name;
  const showTip = tooltip.visible && rect !== null;
  useEffect(() => {
    if (!showTip || !rect) return;
    onTooltip({ text: tipText, x: rect.x + rect.width / 2, y: rect.y + rect.height + rem * 0.3 });
    return () => onTooltip(null);
  }, [showTip, tipText, rect?.x, rect?.y]);
  const size = slot(rem);
  const icon = Math.round(rem * 1.05);
  const attach = (node: NodeHandle | null) => {
    own.current = node;
    if (anchor) setRef(anchor, node);
  };
  const onPointer = (event: PointerEvent) => {
    if (event.kind === "down" && event.button === "right" && rect) {
      tooltip.cancel();
      actions.contextMenu(action.extensionId, rect.x, rect.y + rect.height + rem * 0.25);
      return;
    }
    const inside = event.x >= 0 && event.y >= 0 && event.x <= size && event.y <= size;
    if (event.kind === "up" && event.button === "left" && inside && action.enabled) {
      tooltip.cancel();
      actions.click(action.extensionId);
    }
  };
  return (
    <Box
      ref={attach}
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
        cornerRadius: rem * 0.3,
        background: open ? theme.hover : undefined,
        hoverBackground: theme.hover,
        flexShrink: 0,
      }}
      onPointer={onPointer}
      onMouseEnter={tooltip.enter}
      onMouseLeave={tooltip.leave}
    >
      {action.icon ? (
        <Image
          src={action.icon}
          error={<FallbackIcon name={action.name} size={icon} rem={rem} theme={theme} />}
          style={{ width: icon, height: icon, flexShrink: 0 }}
        />
      ) : (
        <FallbackIcon name={action.name} size={icon} rem={rem} theme={theme} />
      )}
      {!action.enabled && (
        <Box
          style={{
            position: "absolute",
            inset: { top: (size - icon) / 2, left: (size - icon) / 2 },
            width: icon,
            height: icon,
            background: withAlpha(theme.overlay, 150),
          }}
        />
      )}
      {action.badge && <Badge badge={action.badge} size={size} rem={rem} />}
    </Box>
  );
}

export function FallbackIcon({ name, size, rem, theme }: { name: string; size: number; rem: number; theme: Theme }) {
  return (
    <Box
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
        cornerRadius: size * 0.25,
        background: theme.hoverStrong,
        flexShrink: 0,
      }}
    >
      <Text style={{ fontSize: Math.min(rem * 0.62, size * 0.62), color: theme.fg, wrap: false, selectable: false }}>
        {name.slice(0, 1).toUpperCase()}
      </Text>
    </Box>
  );
}

function Badge({
  badge,
  size,
  rem,
}: {
  badge: NonNullable<ToolbarAction["badge"]>;
  size: number;
  rem: number;
}) {
  const text = badge.text.slice(0, 4);
  const fontSize = rem * 0.55;
  const height = Math.round(rem * 0.74);
  const width = Math.max(height, Math.round(text.length * fontSize * 0.6 + rem * 0.3));
  return (
    <Box
      style={{
        position: "absolute",
        inset: { top: size - height + rem * 0.05, left: size - width + rem * 0.12 },
        width,
        height,
        alignItems: "center",
        justifyContent: "center",
        cornerRadius: height / 2,
        background: badge.background as Rgba,
      }}
    >
      <Text style={{ fontSize, color: badge.color as Rgba, fontWeight: "bold", wrap: false, selectable: false }}>{text}</Text>
    </Box>
  );
}

export function ToolbarTooltip({ tip, rem, maxWidth, theme }: { tip: TooltipView; rem: number; maxWidth: number; theme: Theme }) {
  const width = Math.round(tip.text.length * rem * 0.75 * 0.6 + rem * 1.2);
  const left = Math.max(rem * 0.3, Math.min(tip.x - width / 2, maxWidth - width - rem * 0.3));
  return (
    <Box
      style={{
        position: "absolute",
        inset: { top: tip.y, left },
        width,
        height: Math.round(rem * 1.45),
        alignItems: "center",
        justifyContent: "center",
        background: theme.overlay,
        cornerRadius: rem * 0.3,
        border: { width: 1, color: theme.fieldBorder },
      }}
    >
      <Text style={{ fontSize: rem * 0.75, color: theme.fg, wrap: false, selectable: false }}>{tip.text}</Text>
    </Box>
  );
}

const TOOLTIP_DELAY_MS = 700;

function useHoverDelay(suppressed: boolean) {
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  return {
    visible: visible && !suppressed,
    enter: () => {
      clear();
      timer.current = setTimeout(() => setVisible(true), TOOLTIP_DELAY_MS);
    },
    leave: () => {
      clear();
      setVisible(false);
    },
    cancel: () => {
      clear();
      setVisible(false);
    },
  };
}
