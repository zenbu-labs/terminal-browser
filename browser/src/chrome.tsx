import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Image, Input, Path, Scene, Text } from "pixel-react";
import type { EngineInfo, NodeHandle, PointerEvent, Rgba, Surface, WheelEvent } from "pixel-react";

export interface PaletteView {
  index: number;
  items: { id: string; label: string; shortcut: string }[];
}

export interface NewTabView {
  suggestions: string[];
  /** -1 highlights the typed query itself */
  index: number;
}

export interface TabRow {
  id: number;
  title: string;
  favicon: string | null;
  active: boolean;
  loading: boolean;
}

export interface DeviceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DeviceView {
  mode: "phone" | "tablet";
  frame: DeviceRect & { radius: number };
  screen: DeviceRect;
  island: DeviceRect | null;
}

/** width/height are engine pixels, already clamped to fit the page area */
export interface PopupView {
  title: string;
  host: string;
  loading: boolean;
  width: number;
  height: number;
}

export interface BrowserState {
  url: string;
  title: string;
  favicon: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  findMatches: { active: number; total: number } | null;
}

export interface ChromeActions {
  back(): void;
  forward(): void;
  reload(): void;
  urlEdit(): void;
  urlEditCancel(): void;
  urlSubmit(text: string): void;
  pointer(event: PointerEvent): void;
  wheel(event: WheelEvent): void;
  pageHover(hovering: boolean): void;
  findChange(text: string): void;
  findNext(forward: boolean): void;
  findClose(): void;
  paletteQuery(text: string): void;
  paletteRun(index: number): void;
  paletteClose(): void;
  tabSwitch(id: number): void;
  tabClose(id: number): void;
  tabNew(): void;
  newTabQuery(text: string): void;
  newTabSubmit(text: string): void;
  newTabCancel(): void;
  closeConfirmChoose(closePane: boolean): void;
  closeConfirmCancel(): void;
  popupPointer(event: PointerEvent): void;
  popupWheel(event: WheelEvent): void;
  popupClose(): void;
}

export interface ChromeLayout {
  width: number;
  height: number;
  toolbarHeight: number;
  contentHeight: number;
  /** where the page surface sits, inset from the edges so its frame shows */
  page: { x: number; y: number; width: number; height: number };
  rem: number;
}

interface Theme {
  bg: Rgba;
  fg: Rgba;
  muted: Rgba;
  disabled: Rgba;
  accent: Rgba;
  field: Rgba;
  fieldBorder: Rgba;
  hover: Rgba;
  /** hover for targets nested inside an already-hovered row */
  hoverStrong: Rgba;
  hairline: Rgba;
  selection: Rgba;
}

function mix(base: Rgba, toward: Rgba, t: number): Rgba {
  const channel = (b: number, w: number) => Math.round(b + (w - b) * t);
  return [
    channel(base[0], toward[0]),
    channel(base[1], toward[1]),
    channel(base[2], toward[2]),
    255,
  ];
}

function makeTheme(colors: EngineInfo["colors"]): Theme {
  const bg = colors.background ?? [30, 32, 38, 255];
  const fg = colors.foreground ?? [235, 237, 242, 255];
  const accent = colors.palette[12] ?? colors.palette[4] ?? [93, 156, 255, 255];
  return {
    bg,
    fg,
    accent,
    muted: mix(fg, bg, 0.35),
    disabled: mix(fg, bg, 0.7),
    field: mix(bg, fg, 0.06),
    fieldBorder: mix(bg, fg, 0.16),
    hover: mix(bg, fg, 0.12),
    hoverStrong: mix(bg, fg, 0.26),
    hairline: mix(bg, fg, 0.12),
    selection: mix(bg, accent, 0.35),
  };
}

/** approximates a circular arc with cubic segments; angles in degrees, y-down,
 * 0° = right, 90° = down */
function arcPath(cx: number, cy: number, r: number, fromDeg: number, toDeg: number): string {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const segments = Math.max(1, Math.ceil(Math.abs(toDeg - fromDeg) / 90));
  const step = (rad(toDeg) - rad(fromDeg)) / segments;
  const k = (4 / 3) * Math.tan(step / 4);
  const n = (value: number) => Number(value.toFixed(3));
  const px = (t: number) => cx + r * Math.cos(t);
  const py = (t: number) => cy + r * Math.sin(t);
  let a = rad(fromDeg);
  let path = `M ${n(px(a))} ${n(py(a))}`;
  for (let i = 0; i < segments; i++) {
    const b = a + step;
    path +=
      ` C ${n(px(a) - k * r * Math.sin(a))} ${n(py(a) + k * r * Math.cos(a))}` +
      ` ${n(px(b) + k * r * Math.sin(b))} ${n(py(b) - k * r * Math.cos(b))}` +
      ` ${n(px(b))} ${n(py(b))}`;
    a = b;
  }
  return path;
}

/** stroked icon paths in a 24-unit viewbox */
const ICONS = {
  back: "M 14.5 5.5 L 8 12 L 14.5 18.5",
  forward: "M 9.5 5.5 L 16 12 L 9.5 18.5",
  close: "M 7 7 L 17 17 M 17 7 L 7 17",
  plus: "M 12 5.5 L 12 18.5 M 5.5 12 L 18.5 12",
  reload: `${arcPath(12, 12, 6.5, 0, 315)} M 15.77 4.31 L 16.6 7.4 L 13.51 6.57`,
  search: `${arcPath(11, 11, 5.75, 0, 360)} M 15.4 15.4 L 19.25 19.25`,
};

function Icon({
  icon,
  size,
  color,
  weight = 2.2,
}: {
  icon: keyof typeof ICONS;
  size: number;
  color: Rgba;
  weight?: number;
}) {
  return (
    <Scene
      camera={{ x: 0, y: 0, zoom: size / 24 }}
      style={{ width: size, height: size, flexShrink: 0 }}
    >
      <Path d={ICONS[icon]} stroke={{ width: weight, color, cap: "round", join: "round" }} />
    </Scene>
  );
}

export function Chrome({
  state,
  actions,
  layout,
  colors,
  font,
  findOpen,
  palette,
  device,
  tabs,
  newTab,
  closeConfirm,
  urlEdit,
  pending,
  popup,
  pageSurface,
  popupSurface,
}: {
  state: BrowserState;
  actions: ChromeActions;
  layout: ChromeLayout;
  colors: EngineInfo["colors"];
  font: number;
  findOpen: boolean;
  palette: PaletteView | null;
  device: DeviceView | null;
  tabs: TabRow[];
  newTab: NewTabView | null;
  closeConfirm: boolean;
  urlEdit: boolean;
  /** non-null while the initial tab waits on about:blank for a dev server;
   * "" means waiting without a known url */
  pending: string | null;
  popup: PopupView | null;
  pageSurface: Surface;
  popupSurface: Surface;
}) {
  const rem = layout.rem;
  const theme = useMemo(() => makeTheme(colors), [colors]);

  return (
    <Box
      style={{
        width: layout.width,
        height: layout.height,
        flexDirection: "column",
        background: theme.bg,
        color: theme.fg,
        fontSize: rem,
        font,
      }}
    >
      {layout.toolbarHeight > 0 && (
      <Box
        style={{
          height: layout.toolbarHeight,
          flexShrink: 0,
          alignItems: "center",
          gap: rem * 0.25,
          padding: { left: rem * 0.4, right: rem * 0.4 },
        }}
      >
        {(state.canGoBack || state.canGoForward) && (
          <>
            <ToolbarButton
              icon="back"
              enabled={state.canGoBack}
              rem={rem}
              theme={theme}
              onClick={actions.back}
            />
            <ToolbarButton
              icon="forward"
              enabled={state.canGoForward}
              rem={rem}
              theme={theme}
              onClick={actions.forward}
            />
          </>
        )}
        <ToolbarButton
          icon={state.loading ? "close" : "reload"}
          enabled
          rem={rem}
          theme={theme}
          onClick={actions.reload}
        />
        <TabStrip
          tabs={tabs}
          state={state}
          pending={pending}
          actions={actions}
          rem={rem}
          theme={theme}
        />
      </Box>
      )}
      {device ? (
        <DeviceFrame
          device={device}
          layout={layout}
          theme={theme}
          surface={pageSurface}
          actions={actions}
        />
      ) : (
        <>
          <FrameBorder layout={layout} theme={theme} />
          <Box
            id="browser-surface"
            surface={pageSurface}
            style={{
              position: "absolute",
              inset: { top: layout.page.y, left: layout.page.x },
              width: layout.page.width,
              height: layout.page.height,
              cornerRadius: Math.max(2, rem * 0.55 - 1),
              background: theme.bg,
            }}
            onPointer={actions.pointer}
            onWheel={actions.wheel}
            onMouseEnter={() => actions.pageHover(true)}
            onMouseLeave={() => actions.pageHover(false)}
          />
        </>
      )}
      {pending !== null && !device && (
        <EmptyState pending={pending} layout={layout} theme={theme} />
      )}
      {findOpen && (
        <FindBar state={state} actions={actions} layout={layout} theme={theme} />
      )}
      {popup && (
        <PopupModal
          view={popup}
          actions={actions}
          layout={layout}
          theme={theme}
          surface={popupSurface}
        />
      )}
      {newTab && <NewTabCard view={newTab} actions={actions} layout={layout} theme={theme} />}
      {closeConfirm && <CloseConfirmCard actions={actions} layout={layout} theme={theme} />}
      {urlEdit && <UrlCard state={state} actions={actions} layout={layout} theme={theme} />}
      {palette && <PaletteCard view={palette} actions={actions} layout={layout} theme={theme} />}
    </Box>
  );
}

function PaletteCard({
  view,
  actions,
  layout,
  theme,
}: {
  view: PaletteView;
  actions: ChromeActions;
  layout: ChromeLayout;
  theme: Theme;
}) {
  const rem = layout.rem;
  const cardW = Math.min(rem * 26, layout.width - rem * 4);
  const rowH = rem * 2;
  const input = useRef<NodeHandle | null>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  return (
    <>
      <Backdrop layout={layout} onClose={actions.paletteClose} />
      <Box
        style={{
          position: "absolute",
          inset: { top: layout.toolbarHeight + rem * 1.2, left: (layout.width - cardW) / 2 },
          width: cardW,
          flexDirection: "column",
          background: theme.bg,
          cornerRadius: rem * 0.55,
          border: { width: 1, color: theme.fieldBorder },
          overflow: "hidden",
        }}
      >
        <Box
          style={{
            height: rem * 2.4,
            alignItems: "center",
            padding: { left: rem * 0.85, right: rem * 0.85 },
            border: { bottom: [1, theme.hairline] },
          }}
        >
          <Input
            ref={input}
            autoFocus
            style={{ flexGrow: 1, flexBasis: 0, wrap: false, fontSize: rem }}
            caretColor={theme.accent}
            selectionColor={theme.selection}
            onChange={(text) => actions.paletteQuery(text)}
          />
        </Box>
        <Box style={{ flexDirection: "column", padding: { bottom: rem * 0.25 } }}>
          {view.items.length === 0 && (
            <Text
              style={{
                padding: { left: rem * 0.85, top: rem * 0.35, bottom: rem * 0.35 },
                fontSize: rem * 0.92,
                color: theme.muted,
                selectable: false,
              }}
            >
              no matching actions
            </Text>
          )}
          {view.items.map((item, i) => (
            <Box
              key={item.id}
              style={{
                height: rowH,
                alignItems: "center",
                gap: rem * 0.55,
                padding: { left: rem * 0.85, right: rem * 0.85 },
                background: i === view.index ? theme.hover : undefined,
                hoverBackground: theme.hover,
              }}
              onClick={() => actions.paletteRun(i)}
            >
              <Text
                style={{
                  flexGrow: 1,
                  flexBasis: 0,
                  fontSize: rem * 0.95,
                  wrap: false,
                  selectable: false,
                }}
              >
                {item.label}
              </Text>
              <Text
                style={{ fontSize: rem * 0.82, color: theme.muted, wrap: false, selectable: false }}
              >
                {item.shortcut}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>
    </>
  );
}

/** invisible clickable layer under a modal card: closing on outside click and,
 * because clickables block pointer hits, keeping the click off the page */
function Backdrop({ layout, onClose }: { layout: ChromeLayout; onClose(): void }) {
  return (
    <Box
      style={{
        position: "absolute",
        inset: { top: 0, left: 0 },
        width: layout.width,
        height: layout.height,
      }}
      onClick={onClose}
    />
  );
}

function FrameBorder({ layout, theme }: { layout: ChromeLayout; theme: Theme }) {
  return (
    <Box
      style={{
        position: "absolute",
        inset: { top: layout.page.y - 1, left: layout.page.x - 1 },
        width: layout.page.width + 2,
        height: layout.page.height + 2,
        cornerRadius: layout.rem * 0.55,
        border: { width: 1, color: theme.fieldBorder },
      }}
    />
  );
}

function displayUrl(url: string): string {
  if (!url || url === "about:blank") return "new tab";
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

interface TabEntry {
  tab: TabRow;
  width: number;
  ghost: boolean;
}

/** widths tween toward their targets so tabs grow in, shrink out, and resize
 * smoothly; closed tabs linger as ghosts until they finish shrinking */
function useAnimatedTabs(tabs: TabRow[], targetFor: (tab: TabRow) => number): TabEntry[] {
  const ref = useRef<{
    entries: Map<number, TabEntry>;
    order: number[];
    timer: ReturnType<typeof setInterval> | null;
    targetFor: (tab: TabRow) => number;
  }>({ entries: new Map(), order: [], timer: null, targetFor });
  const [, bump] = useState(0);
  const s = ref.current;
  s.targetFor = targetFor;
  const live = new Set(tabs.map((tab) => tab.id));
  for (const tab of tabs) {
    const entry = s.entries.get(tab.id);
    if (entry) {
      entry.tab = tab;
      entry.ghost = false;
    } else {
      s.entries.set(tab.id, { tab, width: 0, ghost: false });
      s.order.push(tab.id);
    }
  }
  for (const entry of s.entries.values()) {
    if (!live.has(entry.tab.id)) entry.ghost = true;
  }
  useEffect(() => {
    const settled = [...s.entries.values()].every(
      (entry) => entry.width === (entry.ghost ? 0 : s.targetFor(entry.tab)),
    );
    if (settled || s.timer) return;
    s.timer = setInterval(() => {
      let moving = false;
      for (const entry of s.entries.values()) {
        const target = entry.ghost ? 0 : s.targetFor(entry.tab);
        const delta = target - entry.width;
        if (Math.abs(delta) < 0.75) entry.width = target;
        else {
          entry.width += delta * 0.3;
          moving = true;
        }
      }
      for (const [id, entry] of s.entries) {
        if (entry.ghost && entry.width === 0) {
          s.entries.delete(id);
          s.order = s.order.filter((o) => o !== id);
        }
      }
      bump((n) => n + 1);
      if (!moving && s.timer) {
        clearInterval(s.timer);
        s.timer = null;
      }
    }, 16);
  });
  useEffect(
    () => () => {
      if (s.timer) clearInterval(s.timer);
    },
    [],
  );
  return s.order
    .map((id) => s.entries.get(id))
    .filter((entry): entry is TabEntry => entry != null);
}

function TabStrip({
  tabs,
  state,
  pending,
  actions,
  rem,
  theme,
}: {
  tabs: TabRow[];
  state: BrowserState;
  pending: string | null;
  actions: ChromeActions;
  rem: number;
  theme: Theme;
}) {
  const single = tabs.length <= 1;
  const [hovered, setHovered] = useState<number | null>(null);
  const activeLabel =
    state.url === "about:blank" && pending ? displayUrl(pending) : displayUrl(state.url);
  const label = (tab: TabRow) => (tab.active ? activeLabel : tab.title || "new tab");
  const charW = rem * 0.82 * 0.6;
  const closeW = rem * 1.25;
  const closeGap = rem * 0.25;
  const entries = useAnimatedTabs(tabs, (tab) => {
    let width = rem * 1.4 + Math.min(label(tab).length, 28) * charW;
    if (tab.loading || tab.favicon) width += (tab.loading ? rem * 0.35 : rem * 0.85) + rem * 0.35;
    if (tab.active) width += closeW + rem * 0.35;
    width += closeW + closeGap + rem * 0.35;
    return Math.round(width);
  });
  return (
    <Box
      style={{
        flexGrow: 1,
        flexBasis: 0,
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
        gap: rem * 0.25,
        padding: { left: rem * 0.4, right: rem * 0.4 },
        overflow: "hidden",
      }}
    >
      {entries.map(({ tab, width, ghost }) => (
        <Box
          key={tab.id}
          style={{
            width: Math.round(width),
            height: rem * 1.5,
            alignItems: "center",
            justifyContent: "center",
            gap: rem * 0.35,
            padding: { left: rem * 0.7, right: rem * 0.7 },
            cornerRadius: rem * 0.75,
            background: tab.active && !ghost && !single ? theme.field : undefined,
            hoverBackground: ghost ? undefined : theme.hover,
            flexShrink: 1,
            overflow: "hidden",
          }}
          onClick={() => (tab.active ? actions.urlEdit() : actions.tabSwitch(tab.id))}
          onMouseEnter={() => setHovered(tab.id)}
          onMouseLeave={() => setHovered((id) => (id === tab.id ? null : id))}
        >
          {tab.loading ? (
            <Box
              style={{
                width: rem * 0.35,
                height: rem * 0.35,
                cornerRadius: rem * 0.175,
                background: theme.accent,
                flexShrink: 0,
              }}
            />
          ) : tab.favicon ? (
            <Image
              src={tab.favicon}
              style={{
                width: rem * 0.85,
                height: rem * 0.85,
                cornerRadius: rem * 0.15,
                flexShrink: 0,
              }}
            />
          ) : null}
          <Text
            style={{
              fontSize: rem * 0.82,
              color: tab.active && !ghost ? theme.fg : theme.muted,
              wrap: false,
              selectable: false,
              flexShrink: 1,
              overflow: "hidden",
            }}
          >
            {ghost ? tab.title || "new tab" : label(tab)}
          </Text>
          {hovered === tab.id && !ghost ? (
            <Box
              style={{
                width: closeW,
                height: closeW,
                alignItems: "center",
                justifyContent: "center",
                margin: { left: closeGap },
                cornerRadius: closeW / 2,
                hoverBackground: theme.hoverStrong,
                flexShrink: 0,
              }}
              onClick={() => actions.tabClose(tab.id)}
            >
              <Icon icon="close" size={rem * 0.78} color={theme.muted} />
            </Box>
          ) : (
            <Box style={{ width: closeW, height: closeW, margin: { left: closeGap }, flexShrink: 0 }} />
          )}
        </Box>
      ))}
      <Box
        style={{
          width: rem * 1.3,
          height: rem * 1.3,
          alignItems: "center",
          justifyContent: "center",
          cornerRadius: rem * 0.65,
          hoverBackground: theme.hover,
          flexShrink: 0,
        }}
        onClick={actions.tabNew}
      >
        <Icon icon="plus" size={rem * 0.85} color={theme.muted} />
      </Box>
    </Box>
  );
}

function UrlCard({
  state,
  actions,
  layout,
  theme,
}: {
  state: BrowserState;
  actions: ChromeActions;
  layout: ChromeLayout;
  theme: Theme;
}) {
  const rem = layout.rem;
  const cardW = Math.min(rem * 28, layout.width - rem * 4);
  const [value, setValue] = useState(state.url === "about:blank" ? "" : state.url);
  const input = useRef<NodeHandle | null>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.selectAll();
  }, []);
  return (
    <>
      <Backdrop layout={layout} onClose={actions.urlEditCancel} />
      <Box
        style={{
          position: "absolute",
          inset: { top: layout.toolbarHeight + rem * 1.2, left: (layout.width - cardW) / 2 },
          width: cardW,
          flexDirection: "column",
          background: theme.bg,
          cornerRadius: rem * 0.55,
          border: { width: 1, color: theme.fieldBorder },
          overflow: "hidden",
        }}
      >
        <Box
          style={{
            height: rem * 2.4,
            alignItems: "center",
            gap: rem * 0.5,
            padding: { left: rem * 0.85, right: rem * 0.85 },
          }}
        >
          <Icon icon="search" size={rem} color={theme.muted} />
          <Input
            ref={input}
            autoFocus
            value={value}
            style={{ flexGrow: 1, flexBasis: 0, wrap: false, fontSize: rem }}
            caretColor={theme.accent}
            selectionColor={theme.selection}
            onChange={setValue}
            onSubmit={(text) => actions.urlSubmit(text)}
          />
        </Box>
      </Box>
    </>
  );
}

function NewTabCard({
  view,
  actions,
  layout,
  theme,
}: {
  view: NewTabView;
  actions: ChromeActions;
  layout: ChromeLayout;
  theme: Theme;
}) {
  const rem = layout.rem;
  const cardW = Math.min(rem * 28, layout.width - rem * 4);
  const rowH = rem * 2;
  const input = useRef<NodeHandle | null>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  return (
    <>
      <Backdrop layout={layout} onClose={actions.newTabCancel} />
      <Box
        style={{
          position: "absolute",
          inset: { top: layout.toolbarHeight + rem * 1.2, left: (layout.width - cardW) / 2 },
          width: cardW,
          flexDirection: "column",
          background: theme.bg,
          cornerRadius: rem * 0.55,
          border: { width: 1, color: theme.fieldBorder },
          overflow: "hidden",
        }}
      >
        <Box
          style={{
            height: rem * 2.4,
            alignItems: "center",
            gap: rem * 0.5,
            padding: { left: rem * 0.85, right: rem * 0.85 },
            border: view.suggestions.length ? { bottom: [1, theme.hairline] } : undefined,
          }}
        >
          <Icon icon="search" size={rem} color={theme.muted} />
          <Input
            ref={input}
            autoFocus
            style={{ flexGrow: 1, flexBasis: 0, wrap: false, fontSize: rem }}
            caretColor={theme.accent}
            selectionColor={theme.selection}
            onChange={(text) => actions.newTabQuery(text)}
          />
        </Box>
        {view.suggestions.length > 0 && (
          <Box style={{ flexDirection: "column", padding: { bottom: rem * 0.25 } }}>
            {view.suggestions.map((suggestion, i) => {
              const maxChars = Math.floor((cardW - rem * 3.15) / (rem * 0.95 * 0.6));
              const shown =
                suggestion.length > maxChars
                  ? `${suggestion.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
                  : suggestion;
              return (
                <Box
                  key={`${i}:${suggestion}`}
                  style={{
                    height: rowH,
                    alignItems: "center",
                    gap: rem * 0.6,
                    padding: { left: rem * 0.85, right: rem * 0.85 },
                    background: i === view.index ? theme.hover : undefined,
                    hoverBackground: theme.hover,
                  }}
                  onClick={() => actions.newTabSubmit(suggestion)}
                >
                  <Icon icon="search" size={rem * 0.8} color={theme.disabled} />
                  <Text
                    style={{
                      flexGrow: 1,
                      flexBasis: 0,
                      flexShrink: 1,
                      fontSize: rem * 0.95,
                      color: i === view.index ? theme.fg : theme.muted,
                      wrap: false,
                      selectable: false,
                      overflow: "hidden",
                    }}
                  >
                    {shown}
                  </Text>
                </Box>
              );
            })}
          </Box>
        )}
      </Box>
    </>
  );
}

function PopupModal({
  view,
  actions,
  layout,
  theme,
  surface,
}: {
  view: PopupView;
  actions: ChromeActions;
  layout: ChromeLayout;
  theme: Theme;
  surface: Surface;
}) {
  const rem = layout.rem;
  const [closeHover, setCloseHover] = useState(false);
  const headerH = Math.round(rem * 1.7);
  const cardH = headerH + view.height;
  const left = layout.page.x + Math.round((layout.page.width - view.width) / 2);
  const top =
    layout.page.y + Math.max(Math.round(rem * 0.5), Math.round((layout.page.height - cardH) / 2));
  return (
    <>
      <Box
        style={{
          position: "absolute",
          inset: { top: layout.page.y, left: layout.page.x },
          width: layout.page.width,
          height: layout.page.height,
          background: [8, 9, 12, 150],
        }}
        onClick={() => actions.popupClose()}
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
            onClick={() => actions.popupClose()}
            onMouseEnter={() => setCloseHover(true)}
            onMouseLeave={() => setCloseHover(false)}
          >
            <Icon icon="close" size={rem * 0.8} color={theme.muted} />
          </Box>
        </Box>
        <Box
          surface={surface}
          style={{ width: view.width, height: view.height, background: theme.bg }}
          onPointer={actions.popupPointer}
          onWheel={actions.popupWheel}
        />
      </Box>
    </>
  );
}

function CloseConfirmCard({
  actions,
  layout,
  theme,
}: {
  actions: ChromeActions;
  layout: ChromeLayout;
  theme: Theme;
}) {
  const rem = layout.rem;
  const cardW = Math.min(rem * 23, layout.width - rem * 4);
  const rowH = rem * 2;
  const options: { label: string; hint: string; closePane: boolean }[] = [
    { label: "close the terminal pane", hint: "y", closePane: true },
    { label: "just exit the browser", hint: "n", closePane: false },
  ];
  return (
    <>
      <Backdrop layout={layout} onClose={actions.closeConfirmCancel} />
      <Box
        style={{
          position: "absolute",
          inset: { top: layout.toolbarHeight + rem * 1.2, left: (layout.width - cardW) / 2 },
          width: cardW,
          flexDirection: "column",
          background: theme.bg,
          cornerRadius: rem * 0.55,
          border: { width: 1, color: theme.fieldBorder },
          overflow: "hidden",
        }}
      >
        <Box
          style={{
            height: rem * 2.4,
            alignItems: "center",
            gap: rem * 0.4,
            padding: { left: rem * 0.85, right: rem * 0.85 },
            border: { bottom: [1, theme.hairline] },
          }}
        >
          <Box
            style={{
              width: rem * 0.5,
              height: rem * 0.5,
              cornerRadius: rem * 0.25,
              background: theme.accent,
            }}
          />
          <Text style={{ fontSize: rem * 0.88, color: theme.muted, wrap: false, selectable: false }}>
            close the last tab?
          </Text>
          <Box style={{ flexGrow: 1, flexBasis: 0 }} />
          <Text style={{ fontSize: rem * 0.82, color: theme.disabled, wrap: false, selectable: false }}>
            esc cancels
          </Text>
        </Box>
        <Box style={{ flexDirection: "column", padding: { top: rem * 0.25, bottom: rem * 0.25 } }}>
          {options.map((option) => (
            <Box
              key={option.hint}
              style={{
                height: rowH,
                alignItems: "center",
                gap: rem * 0.55,
                padding: { left: rem * 0.85, right: rem * 0.85 },
                hoverBackground: theme.hover,
              }}
              onClick={() => actions.closeConfirmChoose(option.closePane)}
            >
              <Text
                style={{
                  flexGrow: 1,
                  flexBasis: 0,
                  fontSize: rem * 0.95,
                  wrap: false,
                  selectable: false,
                }}
              >
                {option.label}
              </Text>
              <Text
                style={{ fontSize: rem * 0.82, color: theme.muted, wrap: false, selectable: false }}
              >
                {option.hint}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>
    </>
  );
}

function DeviceFrame({
  device,
  layout,
  theme,
  surface,
  actions,
}: {
  device: DeviceView;
  layout: ChromeLayout;
  theme: Theme;
  surface: Surface;
  actions: ChromeActions;
}) {
  const { frame, screen, island, mode } = device;
  const frameColor: Rgba = [14, 14, 17, 255];
  const edge: Rgba = [70, 70, 78, 255];
  const nubW = Math.max(2, frame.w * 0.008);
  const nub = (top: number, height: number, left: number) => (
    <Box
      style={{
        position: "absolute",
        inset: { top: top - layout.toolbarHeight, left },
        width: nubW,
        height,
        cornerRadius: nubW / 2,
        background: edge,
      }}
    />
  );
  return (
    <Box
      style={{
        position: "absolute",
        inset: { top: layout.toolbarHeight, left: 0 },
        width: layout.width,
        height: layout.contentHeight,
        background: mix(theme.bg, [0, 0, 0, 255], 0.35),
      }}
    >
      {mode === "phone" && (
        <>
          {nub(frame.y + frame.h * 0.28, frame.h * 0.05, frame.x - nubW + 1)}
          {nub(frame.y + frame.h * 0.36, frame.h * 0.08, frame.x - nubW + 1)}
          {nub(frame.y + frame.h * 0.46, frame.h * 0.08, frame.x - nubW + 1)}
          {nub(frame.y + frame.h * 0.32, frame.h * 0.12, frame.x + frame.w - 1)}
        </>
      )}
      <Box
        style={{
          position: "absolute",
          inset: { top: frame.y - layout.toolbarHeight, left: frame.x },
          width: frame.w,
          height: frame.h,
          cornerRadius: frame.radius,
          background: frameColor,
          border: { width: 1, color: edge },
        }}
      />
      <Box
        id="browser-surface"
        surface={surface}
        style={{
          position: "absolute",
          inset: { top: screen.y - layout.toolbarHeight, left: screen.x },
          width: screen.w,
          height: screen.h,
          cornerRadius: Math.max(4, frame.radius - (screen.x - frame.x)),
        }}
        onPointer={actions.pointer}
        onWheel={actions.wheel}
        onMouseEnter={() => actions.pageHover(true)}
        onMouseLeave={() => actions.pageHover(false)}
      />
      {island && (
        <Box
          style={{
            position: "absolute",
            inset: { top: island.y - layout.toolbarHeight, left: island.x },
            width: island.w,
            height: island.h,
            cornerRadius: island.h / 2,
            background: [5, 5, 6, 255],
          }}
        />
      )}
    </Box>
  );
}

function FindBar({
  state,
  actions,
  layout,
  theme,
}: {
  state: BrowserState;
  actions: ChromeActions;
  layout: ChromeLayout;
  theme: Theme;
}) {
  const rem = layout.rem;
  const [text, setText] = useState("");
  const matches = state.findMatches;
  const count = matches ? `${matches.total ? matches.active : 0}/${matches.total}` : "";
  const change = (value: string) => {
    setText(value);
    actions.findChange(value);
  };
  return (
    <Box
      style={{
        position: "absolute",
        inset: { top: layout.toolbarHeight + rem * 0.45, right: rem * 0.75 },
        width: rem * 16,
        height: rem * 2,
        alignItems: "center",
        gap: rem * 0.2,
        padding: { left: rem * 0.6, right: rem * 0.3 },
        background: theme.bg,
        cornerRadius: rem * 0.5,
        border: { width: 1, color: theme.fieldBorder },
      }}
    >
      <Input
        value={text}
        autoFocus
        style={{ flexGrow: 1, flexBasis: 0, wrap: false, fontSize: rem * 0.9 }}
        caretColor={theme.accent}
        selectionColor={theme.selection}
        onChange={change}
      />
      <Text style={{ color: theme.muted, fontSize: rem * 0.8, selectable: false }}>
        {count}
      </Text>
      <FindButton icon="back" rem={rem} theme={theme} onClick={() => actions.findNext(false)} />
      <FindButton icon="forward" rem={rem} theme={theme} onClick={() => actions.findNext(true)} />
      <FindButton icon="close" rem={rem} theme={theme} onClick={actions.findClose} />
    </Box>
  );
}

function FindButton({
  icon,
  rem,
  theme,
  onClick,
}: {
  icon: keyof typeof ICONS;
  rem: number;
  theme: Theme;
  onClick(): void;
}) {
  return (
    <Box
      style={{
        width: rem * 1.2,
        height: rem * 1.2,
        alignItems: "center",
        justifyContent: "center",
        cornerRadius: rem * 0.25,
        hoverBackground: theme.hover,
        flexShrink: 0,
      }}
      onClick={onClick}
    >
      <Icon icon={icon} size={rem * 0.8} color={theme.muted} />
    </Box>
  );
}

function EmptyState({
  pending,
  layout,
  theme,
}: {
  pending: string;
  layout: ChromeLayout;
  theme: Theme;
}) {
  const rem = layout.rem;
  return (
    <Box
      style={{
        position: "absolute",
        inset: { top: layout.page.y, left: layout.page.x },
        width: layout.page.width,
        height: layout.page.height,
        cornerRadius: Math.max(2, rem * 0.55 - 1),
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: rem * 0.85,
        background: theme.bg,
      }}
    >
      <Box style={{ alignItems: "center", gap: rem * 0.5 }}>
        <Box
          style={{
            width: rem * 0.5,
            height: rem * 0.5,
            cornerRadius: rem * 0.25,
            background: theme.accent,
          }}
        />
        <Text style={{ fontSize: rem * 0.95, selectable: false }}>
          waiting for the dev server
        </Text>
      </Box>
      {pending !== "" && (
        <Text style={{ color: theme.muted, fontSize: rem * 0.88, selectable: false }}>
          {pending}
        </Text>
      )}
      <Text style={{ color: theme.disabled, fontSize: rem * 0.78, selectable: false }}>
        the page loads here the moment it's up · ⌘J shows the logs
      </Text>
    </Box>
  );
}

function ToolbarButton({
  icon,
  enabled,
  rem,
  theme,
  onClick,
}: {
  icon: keyof typeof ICONS;
  enabled: boolean;
  rem: number;
  theme: Theme;
  onClick(): void;
}) {
  return (
    <Box
      style={{
        width: rem * 1.5,
        height: rem * 1.5,
        alignItems: "center",
        justifyContent: "center",
        cornerRadius: rem * 0.3,
        hoverBackground: enabled ? theme.hover : undefined,
        flexShrink: 0,
      }}
      onClick={enabled ? onClick : undefined}
    >
      <Icon icon={icon} size={rem * 0.95} color={enabled ? theme.muted : theme.disabled} />
    </Box>
  );
}
