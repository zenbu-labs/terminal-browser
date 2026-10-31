import { useState } from "react";
import type { ReactNode } from "react";
import { Box, Text } from "@zenbu-labs/pixel";
import { Icon } from "./icons";
import type { IconName } from "./icons";
import { mix } from "./theme";
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
  const metrics = menuMetrics(rem);
  const zoom = view.zoomPercent !== undefined;
  const width = menuWidth(view.items, metrics, zoom ? rem * 14 : rem * 10);
  const height = menuHeight(view.items, metrics) + (zoom ? metrics.rowH + metrics.dividerH : 0);
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
      <MenuCard
        items={view.items}
        x={x}
        y={y}
        width={width}
        metrics={metrics}
        layout={layout}
        theme={theme}
        cursor={view.cursor}
        onAction={actions.pageMenuAction}
      >
        {zoom && (
          <>
            <Box style={{ height: 1, margin: { top: metrics.pad, bottom: metrics.pad }, background: theme.hairline, flexShrink: 0 }} />
            <ZoomRow percent={view.zoomPercent!} rowH={metrics.rowH} rem={rem} theme={theme} actions={actions} />
          </>
        )}
      </MenuCard>
    </>
  );
}

interface MenuMetrics {
  rem: number;
  rowH: number;
  pad: number;
  dividerH: number;
  charW: number;
  shortcutW: number;
  gutter: number;
}

function menuMetrics(rem: number): MenuMetrics {
  const pad = Math.round(rem * 0.25);
  return {
    rem,
    rowH: Math.round(rem * 1.7),
    pad,
    dividerH: pad * 2 + 1,
    charW: rem * 0.82 * 0.6,
    shortcutW: rem * 0.72 * 0.6,
    gutter: rem * 1.25,
  };
}

const hasChecks = (items: PageMenuItem[]) => items.some((item) => item.checked !== undefined);

function menuWidth(items: PageMenuItem[], m: MenuMetrics, min: number): number {
  const gutter = hasChecks(items) ? m.gutter : 0;
  return Math.round(
    items.reduce((widest, item) => {
      if (item.separator) return widest;
      let row = m.rem * 1.8 + m.pad * 2 + gutter + item.label.length * m.charW;
      if (item.shortcut) row += m.rem * 1 + item.shortcut.length * m.shortcutW;
      if (item.badge) row += m.rem * 1.6 + item.badge.text.length * m.shortcutW;
      if (item.children) row += m.rem * 1.6;
      return Math.max(widest, row);
    }, min),
  );
}

function menuHeight(items: PageMenuItem[], m: MenuMetrics): number {
  return items.reduce((sum, item) => sum + (item.separator ? m.dividerH : m.rowH), m.pad * 2);
}

function MenuCard({
  items,
  x,
  y,
  width,
  metrics,
  layout,
  theme,
  cursor,
  onAction,
  children,
}: {
  items: PageMenuItem[];
  x: number;
  y: number;
  width: number;
  metrics: MenuMetrics;
  layout: ChromeLayout;
  theme: Theme;
  cursor: number[];
  onAction(id: string): void;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const rem = metrics.rem;
  const gutter = hasChecks(items);
  let offset = metrics.pad;
  const tops = items.map((item) => {
    const top = offset;
    offset += item.separator ? metrics.dividerH : metrics.rowH;
    return top;
  });
  const keyed = cursor.length > 0 ? cursor[0] : -1;
  const child = (cursor.length > 1 ? items[keyed] : undefined) ?? items.find((item) => item.id === open && item.children);
  const childAt = child ? tops[items.indexOf(child)] : 0;
  const childWidth = child?.children ? menuWidth(child.children, metrics, rem * 8) : 0;
  const childHeight = child?.children ? menuHeight(child.children, metrics) : 0;
  const rightSide = x + width - metrics.pad;
  const childX = rightSide + childWidth <= layout.width - 4 ? rightSide : Math.max(2, x - childWidth + metrics.pad);
  const childY = Math.max(2, Math.min(y + childAt - metrics.pad, layout.height - childHeight - 4));
  return (
    <>
      <Box
        style={{
          position: "absolute",
          inset: { top: y, left: x },
          width,
          flexDirection: "column",
          padding: metrics.pad,
          background: theme.overlay,
          cornerRadius: rem * 0.45,
          border: { width: 1, color: theme.fieldBorder },
          overflow: "hidden",
        }}
      >
        {items.map((item, index) =>
          item.separator ? (
            <Box
              key={item.id}
              style={{ height: 1, margin: { top: metrics.pad, bottom: metrics.pad }, background: theme.hairline, flexShrink: 0 }}
            />
          ) : (
            <MenuRow
              key={item.id}
              item={item}
              gutter={gutter ? metrics.gutter : 0}
              expanded={item.id === child?.id || index === keyed}
              rowH={metrics.rowH}
              rem={rem}
              theme={theme}
              onHover={() => setOpen(item.children && item.enabled ? item.id : null)}
              onClick={() => {
                if (item.children) setOpen(item.id);
                else onAction(item.id);
              }}
            />
          ),
        )}
        {children}
      </Box>
      {child?.children && (
        <MenuCard
          key={child.id}
          items={child.children}
          x={childX}
          y={childY}
          width={childWidth}
          metrics={metrics}
          layout={layout}
          theme={theme}
          cursor={cursor.length > 1 && items[keyed] === child ? cursor.slice(1) : []}
          onAction={onAction}
        />
      )}
    </>
  );
}

function MenuRow({
  item,
  gutter,
  expanded,
  rowH,
  rem,
  theme,
  onHover,
  onClick,
}: {
  item: PageMenuItem;
  gutter: number;
  expanded: boolean;
  rowH: number;
  rem: number;
  theme: Theme;
  onHover(): void;
  onClick(): void;
}) {
  return (
    <Box
      style={{
        height: rowH,
        alignItems: "center",
        gap: rem * 0.45,
        padding: { left: rem * 0.4, right: item.children ? rem * 0.3 : rem * 0.6 },
        background: expanded ? theme.hover : undefined,
        hoverBackground: item.enabled ? theme.hover : undefined,
        cornerRadius: rem * 0.3,
        flexShrink: 0,
      }}
      onMouseEnter={onHover}
      onClick={item.enabled ? onClick : undefined}
    >
      {gutter > 0 && (
        <Box style={{ width: gutter - rem * 0.45, alignItems: "center", flexShrink: 0 }}>
          {item.checked && <Icon icon="check" size={rem * 0.85} color={item.enabled ? theme.fg : theme.disabled} />}
        </Box>
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
      {item.badge && <MenuBadge badge={item.badge} rem={rem} theme={theme} />}
      {item.children && <Icon icon="forward" size={rem * 0.8} color={item.enabled ? theme.muted : theme.disabled} />}
    </Box>
  );
}

// An extension's badge text, as a quiet pill tinted with its badge colour.
function MenuBadge({ badge, rem, theme }: { badge: NonNullable<PageMenuItem["badge"]>; rem: number; theme: Theme }) {
  return (
    <Box
      style={{
        height: Math.round(rem * 1.05),
        alignItems: "center",
        padding: { left: rem * 0.35, right: rem * 0.35 },
        cornerRadius: rem * 0.525,
        background: mix(theme.overlay, badge.color, 0.28),
        flexShrink: 0,
      }}
    >
      <Text style={{ fontSize: rem * 0.66, color: theme.muted, wrap: false, selectable: false }}>{badge.text}</Text>
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
