import { Box, Text } from "@zenbu-labs/pixel";
import { Icon } from "./icons";
import type { IconName } from "./icons";
import type { Theme } from "./theme";
import type { ChromeActions, ChromeLayout, PageMenuItem, PageMenuView } from "./types";

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
  const rowH = Math.round(rem * 1.7);
  const menuPad = Math.round(rem * 0.25);
  const charW = rem * 0.82 * 0.6;
  const shortcutW = rem * 0.72 * 0.6;
  const width = Math.round(
    view.items.reduce((widest, item) => {
      let row = rem * 1.8 + menuPad * 2 + item.label.length * charW;
      if (item.shortcut) row += rem * 1 + item.shortcut.length * shortcutW;
      return Math.max(widest, row);
    }, view.zoomPercent === undefined ? rem * 10 : rem * 14),
  );
  const dividerH = menuPad * 2 + 1;
  const height = view.items.length * rowH + menuPad * 2 + (view.zoomPercent === undefined ? 0 : rowH + dividerH);
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
          padding: menuPad,
          background: theme.overlay,
          cornerRadius: rem * 0.45,
          border: { width: 1, color: theme.fieldBorder },
          overflow: "hidden",
        }}
      >
        {view.items.map((item) => (
          <MenuRow key={item.id} item={item} rowH={rowH} rem={rem} theme={theme} actions={actions} />
        ))}
        {view.zoomPercent !== undefined && (
          <>
            <Box style={{ height: 1, margin: { top: menuPad, bottom: menuPad }, background: theme.hairline, flexShrink: 0 }} />
            <ZoomRow percent={view.zoomPercent} rowH={rowH} rem={rem} theme={theme} actions={actions} />
          </>
        )}
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
}: {
  item: PageMenuItem;
  rowH: number;
  rem: number;
  theme: Theme;
  actions: ChromeActions;
}) {
  return (
    <Box
      style={{
        height: rowH,
        alignItems: "center",
        gap: rem * 0.45,
        padding: { left: rem * 0.4, right: rem * 0.6 },
        hoverBackground: item.enabled ? theme.hover : undefined,
        cornerRadius: rem * 0.3,
        flexShrink: 0,
      }}
      onClick={item.enabled ? () => actions.pageMenuAction(item.id) : undefined}
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

function ZoomRow({
  percent,
  rowH,
  rem,
  theme,
  actions,
}: {
  percent: number;
  rowH: number;
  rem: number;
  theme: Theme;
  actions: ChromeActions;
}) {
  const controlH = Math.round(rem * 1.3);
  const divider = <Box style={{ width: 1, height: controlH, background: theme.fieldBorder, flexShrink: 0 }} />;
  return (
    <Box
      style={{ height: rowH, alignItems: "center", gap: rem * 0.45, padding: { left: rem * 0.4, right: rem * 0.4 }, flexShrink: 0 }}
      onClick={() => {}}
    >
      <Text style={{ flexGrow: 1, flexBasis: 0, fontSize: rem * 0.82, color: theme.fg, wrap: false, selectable: false }}>
        Zoom
      </Text>
      <Box
        style={{
          height: controlH,
          alignItems: "center",
          cornerRadius: rem * 0.35,
          border: { width: 1, color: theme.fieldBorder },
          background: theme.field,
          overflow: "hidden",
          flexShrink: 0,
        }}
      >
        <ZoomButton icon="minus" size={controlH} rem={rem} theme={theme} onClick={() => actions.pageMenuZoom(-1)} />
        {divider}
        <Box style={{ width: rem * 3, height: controlH, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Text style={{ fontSize: rem * 0.75, color: theme.fg, wrap: false, selectable: false }}>{`${percent}%`}</Text>
        </Box>
        {divider}
        <ZoomButton icon="plus" size={controlH} rem={rem} theme={theme} onClick={() => actions.pageMenuZoom(1)} />
      </Box>
    </Box>
  );
}

function ZoomButton({
  icon,
  size,
  rem,
  theme,
  onClick,
}: {
  icon: IconName;
  size: number;
  rem: number;
  theme: Theme;
  onClick(): void;
}) {
  return (
    <Box
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
        cornerRadius: rem * 0.3,
        hoverBackground: theme.hover,
        flexShrink: 0,
      }}
      onClick={onClick}
    >
      <Icon icon={icon} size={rem * 0.8} color={theme.muted} />
    </Box>
  );
}
