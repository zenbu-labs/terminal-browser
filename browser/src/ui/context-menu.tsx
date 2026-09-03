import { Box, Image, Path, Text } from "pixel-react";
import type { Theme } from "./theme";
import type { ChromeActions, ChromeLayout, PageMenuIcon, PageMenuItem, PageMenuView } from "./types";

export function PageContextMenu({
  view,
  actions,
  layout,
  theme,
}: {
  view: PageMenuView;
  actions: ChromeActions;
  layout: ChromeLayout;
  theme: Theme;
}) {
  const rem = layout.rem;
  const rowH = Math.round(rem * 1.55);
  const charW = rem * 0.82 * 0.6;
  const shortcutW = rem * 0.72 * 0.6;
  const hasIcons = view.items.some((item) => item.icon);
  const width = Math.round(
    view.items.reduce((widest, item) => {
      let row = rem * 1.4 + item.label.length * charW;
      if (hasIcons) row += rem * 1.2;
      if (item.shortcut) row += rem * 0.6 + item.shortcut.length * shortcutW;
      return Math.max(widest, row);
    }, rem * 9),
  );
  const height = view.items.length * rowH;
  const x = Math.max(2, Math.min(view.x, layout.width - width - 4));
  const y = Math.max(2, Math.min(view.y, layout.height - height - 4));
  return (
    <>
      <Box
        style={{
          position: "absolute",
          inset: { top: 0, left: 0 },
          width: layout.width,
          height: layout.height,
        }}
        onClick={() => actions.pageMenuClose()}
      />
      <Box
        style={{
          position: "absolute",
          inset: { top: y, left: x },
          width,
          flexDirection: "column",
          background: theme.field,
          cornerRadius: rem * 0.45,
          border: { width: 1, color: theme.fieldBorder },
          overflow: "hidden",
        }}
      >
        {view.items.map((item, i) => (
          <MenuRow
            key={item.id}
            item={item}
            rowH={rowH}
            rem={rem}
            theme={theme}
            actions={actions}
            first={i === 0}
            last={i === view.items.length - 1}
            alignIcons={hasIcons}
          />
        ))}
      </Box>
    </>
  );
}

function MenuRow({
  item,
  rowH,
  rem,
  theme,
  actions,
  first,
  last,
  alignIcons,
}: {
  item: PageMenuItem;
  rowH: number;
  rem: number;
  theme: Theme;
  actions: ChromeActions;
  first: boolean;
  last: boolean;
  alignIcons: boolean;
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
      onClick={item.enabled ? () => actions.pageMenuAction(item.id) : undefined}
    >
      {item.icon ? (
        <MenuIcon icon={item.icon} enabled={item.enabled} rem={rem} theme={theme} />
      ) : (
        alignIcons && <Box style={{ width: rem * 1.2, flexShrink: 0 }} />
      )}
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

function MenuIcon({
  icon,
  enabled,
  rem,
  theme,
}: {
  icon: PageMenuIcon;
  enabled: boolean;
  rem: number;
  theme: Theme;
}) {
  switch (icon.kind) {
    case "image": {
      const size = rem * 0.95;
      return (
        <Image
          src={icon.src}
          error={<Box style={{ width: size, height: size }} />}
          style={{
            width: size,
            height: size,
            flexShrink: 0,
            margin: { left: -rem * 0.1, right: rem * 0.35 },
          }}
        />
      );
    }
    case "path":
      return (
        <Path
          d={icon.d}
          viewBox={24}
          stroke={{
            width: icon.weight ?? 2.2,
            color: enabled ? (icon.tint === "red" ? theme.red : theme.muted) : theme.disabled,
            cap: "round",
            join: "round",
          }}
          style={{
            width: rem * 0.75,
            height: rem * 0.75,
            flexShrink: 0,
            margin: { right: rem * 0.45 },
          }}
        />
      );
  }
}
