import { Box, Text } from "./react";
import type { Theme } from "./theme";

export interface MenuItem {
  id: string;
  label: string;
  enabled: boolean;
  shortcut: string;
}

export function ContextMenu({
  x,
  y,
  bounds,
  items,
  rem,
  theme,
  onAction,
  onClose,
}: {
  x: number;
  y: number;
  bounds: { width: number; height: number };
  items: MenuItem[];
  rem: number;
  theme: Theme;
  onAction(id: string): void;
  onClose(): void;
}) {
  const rowH = Math.round(rem * 1.55);
  const charW = rem * 0.82 * 0.6;
  const shortcutW = rem * 0.72 * 0.6;
  const width = Math.round(
    items.reduce((widest, item) => {
      let row = rem * 1.4 + item.label.length * charW;
      if (item.shortcut) row += rem * 0.6 + item.shortcut.length * shortcutW;
      return Math.max(widest, row);
    }, rem * 9),
  );
  const height = items.length * rowH;
  const left = Math.max(2, Math.min(x, bounds.width - width - 4));
  const top = Math.max(2, Math.min(y, bounds.height - height - 4));
  return (
    <Box
      style={{
        position: "absolute",
        inset: { top, left },
        width,
        flexDirection: "column",
        background: theme.field,
        cornerRadius: rem * 0.45,
        border: { width: 1, color: theme.fieldBorder },
        overflow: "hidden",
      }}
      onClickOutside={onClose}
    >
      {items.map((item, i) => (
        <MenuRow
          key={item.id}
          item={item}
          rowH={rowH}
          rem={rem}
          theme={theme}
          onAction={onAction}
          first={i === 0}
          last={i === items.length - 1}
        />
      ))}
    </Box>
  );
}

function MenuRow({
  item,
  rowH,
  rem,
  theme,
  onAction,
  first,
  last,
}: {
  item: MenuItem;
  rowH: number;
  rem: number;
  theme: Theme;
  onAction(id: string): void;
  first: boolean;
  last: boolean;
}) {
  const radius = Math.max(2, rem * 0.45 - 1);
  return (
    <Box
      style={{
        height: rowH,
        alignItems: "center",
        padding: { left: rem * 0.7, right: rem * 0.7 },
        hoverBackground: item.enabled ? theme.hover : undefined,
        cornerRadius: {
          topLeft: first ? radius : 0,
          topRight: first ? radius : 0,
          bottomLeft: last ? radius : 0,
          bottomRight: last ? radius : 0,
        },
        flexShrink: 0,
      }}
      onClick={item.enabled ? () => onAction(item.id) : undefined}
    >
      <Text
        style={{
          flexGrow: 1,
          flexBasis: 0,
          fontSize: rem * 0.82,
          color: item.enabled ? theme.fg : theme.disabled,
          wrap: false,
          selectable: false,
        }}
      >
        {item.label}
      </Text>
      {item.shortcut && (
        <Text
          style={{
            fontSize: rem * 0.72,
            color: item.enabled ? theme.muted : theme.disabled,
            wrap: false,
            selectable: false,
          }}
        >
          {item.shortcut}
        </Text>
      )}
    </Box>
  );
}
