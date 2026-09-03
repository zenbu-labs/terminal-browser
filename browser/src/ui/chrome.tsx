import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text } from "pixel-react";
import type { EngineInfo, Surface } from "pixel-react";
import type { BrowserState } from "../page/types";
import { Icon } from "./icons";
import type { IconName } from "./icons";
import { PageContextMenu } from "./context-menu";
import { MarkupCanvas } from "./markup-canvas";
import { NewTabCard, PaletteCard, UrlCard } from "./modals";
import { DownloadHud, FindBar, Toast, ZoomHud } from "./overlays";
import { PopupModal } from "./popup-modal";
import {
  RecordBar,
  RecordCornerButton,
  RecordToolbarPill,
  ReviewToolbar,
} from "./record-bar";
import { TabStrip } from "./tab-strip";
import { makeTheme } from "./theme";
import type { Theme } from "./theme";
import type { RecordView } from "../record/types";
import type {
  ChromeActions,
  ChromeLayout,
  DownloadView,
  NewTabView,
  PageMenuView,
  PaletteView,
  PopupView,
  TabRow,
} from "./types";

export function Chrome({
  state,
  actions,
  layout,
  colors,
  font,
  findOpen,
  palette,
  tabs,
  newTab,
  urlEdit,
  noOverlays,
  popup,
  zoomHud,
  download,
  toast,
  pageMenu,
  dividerEngaged,
  record,
  recordSurface,
  pageSurface,
  popupSurface,
  devtoolsSurface,
}: {
  state: BrowserState;
  actions: ChromeActions;
  layout: ChromeLayout;
  colors: EngineInfo["colors"];
  font: number;
  findOpen: boolean;
  palette: PaletteView | null;
  tabs: TabRow[];
  newTab: NewTabView | null;
  urlEdit: boolean;
  noOverlays: boolean;
  popup: PopupView | null;
  zoomHud: number | null;
  download: DownloadView | null;
  toast: { text: string; detail?: string; failed: boolean; alert: boolean } | null;
  pageMenu: PageMenuView | null;
  dividerEngaged: boolean;
  record: RecordView | null;
  recordSurface: Surface | null;
  pageSurface: Surface;
  popupSurface: Surface;
  devtoolsSurface: Surface;
}) {
  const theme = useMemo(() => makeTheme(colors), [colors]);
  const progress = useProgress(!noOverlays && state.loading);
  return (
    <Box
      style={{
        width: layout.width,
        height: layout.height,
        flexDirection: "column",
        background: theme.bg,
        color: theme.fg,
        fontSize: layout.rem,
        font,
      }}
    >
      {layout.toolbarHeight > 0 &&
        (record?.stopped ? (
          <ReviewToolbar view={record} actions={actions} layout={layout} theme={theme} />
        ) : (
          <Toolbar
            state={state}
            actions={actions}
            layout={layout}
            theme={theme}
            tabs={tabs}
            record={record}
          />
        ))}
      <BrowserTabContents
        layout={layout}
        theme={theme}
        surface={pageSurface}
        actions={actions}
        interactive={!record?.canvas}
      />
      {layout.devtools && (
        <DevtoolsPane
          layout={layout}
          theme={theme}
          surface={devtoolsSurface}
          actions={actions}
          dividerEngaged={dividerEngaged}
        />
      )}
      {record?.canvas && recordSurface && (
        <MarkupCanvas
          view={record.canvas}
          surface={recordSurface}
          actions={actions}
          layout={layout}
          theme={theme}
        />
      )}
      {record && layout.recordBarHeight > 0 && (
        <RecordBar view={record} actions={actions} layout={layout} theme={theme} />
      )}
      {record && layout.toolbarHeight === 0 && (
        <RecordCornerButton view={record} actions={actions} layout={layout} theme={theme} />
      )}
      {pageMenu && (
        <PageContextMenu view={pageMenu} actions={actions} layout={layout} theme={theme} />
      )}
      {findOpen && (
        <FindBar state={state} actions={actions} layout={layout} theme={theme} />
      )}
      {zoomHud != null && (
        <ZoomHud factor={zoomHud} layout={layout} theme={theme} findOpen={findOpen} />
      )}
      {download && <DownloadHud download={download} layout={layout} theme={theme} />}
      {toast && <Toast toast={toast} layout={layout} theme={theme} />}
      {popup && (
        <PopupModal
          view={popup}
          actions={actions}
          layout={layout}
          theme={theme}
          surface={popupSurface}
        />
      )}
      {progress != null && (
        <Box
          style={{
            position: "absolute",
            inset: { top: layout.page.y - 1, left: layout.page.x - 1 },
            width: Math.round(Math.min(1, progress) * (layout.page.width + 2)),
            height: Math.max(2, Math.round(layout.rem * 0.12)),
            overflow: "hidden",
          }}
        >
          <Box
            style={{
              width: layout.page.width + 2,
              height: Math.round(layout.rem * 2),
              flexShrink: 0,
              cornerRadius: layout.frame ? layout.rem * 0.55 : 0,
              border: {
                width: Math.max(2, Math.round(layout.rem * 0.12)),
                color: theme.accent,
              },
            }}
          />
        </Box>
      )}
      {newTab && <NewTabCard view={newTab} actions={actions} layout={layout} theme={theme} />}
      {urlEdit && <UrlCard state={state} actions={actions} layout={layout} theme={theme} />}
      {palette && <PaletteCard view={palette} actions={actions} layout={layout} theme={theme} />}
    </Box>
  );
}

const RAMP_S = 1.4;
const DONE_GRACE_MS = 250;
const LINGER_MS = 200;

function useProgress(loading: boolean): number | null {
  const [progress, setProgress] = useState<number | null>(null);
  const s = useRef({
    start: 0,
    doneAt: 0,
    timer: null as ReturnType<typeof setInterval> | null,
  }).current;
  if (loading) {
    if (!s.start) s.start = Date.now();
    s.doneAt = 0;
  } else if (s.start && !s.doneAt) {
    s.doneAt = Date.now();
  }
  useEffect(() => {
    if (!s.start || s.timer) return;
    s.timer = setInterval(() => {
      const now = Date.now();
      if (s.doneAt && now - s.doneAt >= DONE_GRACE_MS + LINGER_MS) {
        s.start = 0;
        s.doneAt = 0;
        clearInterval(s.timer!);
        s.timer = null;
        setProgress(null);
        return;
      }
      if (s.doneAt && now - s.doneAt >= DONE_GRACE_MS) {
        setProgress(1);
        return;
      }
      const elapsed = (now - s.start) / 1000;
      setProgress(0.08 + 0.87 * (1 - Math.exp(-elapsed / RAMP_S)));
    }, 16);
  });
  useEffect(
    () => () => {
      if (s.timer) clearInterval(s.timer);
    },
    [],
  );
  return progress;
}

const STOP_ICON_MIN_MS = 250;

function useStopIcon(loading: boolean): boolean {
  const [show, setShow] = useState(loading);
  const since = useRef(0);
  useEffect(() => {
    if (loading) {
      since.current = Date.now();
      setShow(true);
      return;
    }
    const left = STOP_ICON_MIN_MS - (Date.now() - since.current);
    if (left <= 0) {
      setShow(false);
      return;
    }
    const timer = setTimeout(() => setShow(false), left);
    return () => clearTimeout(timer);
  }, [loading]);
  return show;
}

function Toolbar({
  state,
  actions,
  layout,
  theme,
  tabs,
  record,
}: {
  state: BrowserState;
  actions: ChromeActions;
  layout: ChromeLayout;
  theme: Theme;
  tabs: TabRow[];
  record: RecordView | null;
}) {
  const rem = layout.rem;
  const stopIcon = useStopIcon(state.loading);
  const nav = state.canGoBack || state.canGoForward;
  const stripWidth =
    layout.width -
    rem * 0.8 -
    rem * 3.3 -
    (nav ? rem * 3.5 : 0) -
    (record ? rem * 7.25 : 0);
  return (
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
        icon={stopIcon ? "close" : "reload"}
        enabled
        rem={rem}
        theme={theme}
        onClick={actions.reload}
      />
      <TabStrip
        tabs={tabs}
        actions={actions}
        rem={rem}
        width={stripWidth}
        url={state.url}
        theme={theme}
      />
      {record && <RecordToolbarPill view={record} actions={actions} rem={rem} theme={theme} />}
    </Box>
  );
}


function seamRadius(radius: number, dock: "bottom" | "right" | null, side: "page" | "devtools") {
  if (!dock) return radius;
  if (side === "page") {
    return dock === "bottom"
      ? { topLeft: radius, topRight: radius, bottomLeft: 0, bottomRight: 0 }
      : { topLeft: radius, bottomLeft: radius, topRight: 0, bottomRight: 0 };
  }
  return dock === "bottom"
    ? { bottomLeft: radius, bottomRight: radius, topLeft: 0, topRight: 0 }
    : { topRight: radius, bottomRight: radius, topLeft: 0, bottomLeft: 0 };
}

function BrowserTabContents({
  layout,
  theme,
  surface,
  actions,
  interactive,
}: {
  layout: ChromeLayout;
  theme: Theme;
  surface: Surface;
  actions: ChromeActions;
  interactive: boolean;
}) {
  const dock = layout.devtools?.dock ?? null;
  return (
    <>
      {interactive && layout.frame && (
        <Box
          style={{
            position: "absolute",
            inset: { top: layout.page.y - 1, left: layout.page.x - 1 },
            width: layout.page.width + 2,
            height: layout.page.height + 2,
            cornerRadius: seamRadius(layout.rem * 0.55, dock, "page"),
            border: { width: 1, color: theme.fieldBorder },
          }}
        />
      )}
      <Box
        id="browser-surface"
        surface={surface}
        style={{
          position: "absolute",
          inset: { top: layout.page.y, left: layout.page.x },
          width: layout.page.width,
          height: layout.page.height,
          cornerRadius: layout.frame
            ? seamRadius(Math.max(2, layout.rem * 0.55 - 1), dock, "page")
            : 0,
          background: theme.bg,
        }}
        onPointer={interactive ? actions.pointer : undefined}
        onWheel={interactive ? actions.wheel : undefined}
        onMouseEnter={() => actions.pageHover(true)}
        onMouseLeave={() => actions.pageHover(false)}
      />
    </>
  );
}

const DIVIDER_ACTIVE = [58, 96, 168, 255] as const;
const DIVIDER_GRIP = [118, 122, 132, 255] as const;

function DevtoolsPane({
  layout,
  theme,
  surface,
  actions,
  dividerEngaged,
}: {
  layout: ChromeLayout;
  theme: Theme;
  surface: Surface;
  actions: ChromeActions;
  dividerEngaged: boolean;
}) {
  const rect = layout.devtools!;
  const horizontal = rect.dock === "bottom";
  const grab = Math.max(8, Math.round(layout.rem * 0.5));
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
        style={{
          position: "absolute",
          inset: { top: rect.y - 1, left: rect.x - 1 },
          width: rect.width + 2,
          height: rect.height + 2,
          cornerRadius: seamRadius(layout.rem * 0.55, rect.dock, "devtools"),
          border: { width: 1, color: theme.fieldBorder },
        }}
      />
      <Box
        id="devtools-surface"
        surface={surface}
        style={{
          position: "absolute",
          inset: { top: rect.y, left: rect.x },
          width: rect.width,
          height: rect.height,
          cornerRadius: seamRadius(Math.max(2, layout.rem * 0.55 - 1), rect.dock, "devtools"),
          background: theme.bg,
        }}
        onPointer={actions.devtoolsPointer}
        onWheel={actions.devtoolsWheel}
        onMouseEnter={() => actions.devtoolsHover(true)}
        onMouseLeave={() => actions.devtoolsHover(false)}
      />
      <Box
        id="devtools-divider"
        style={{
          position: "absolute",
          inset: { top: divider.y, left: divider.x },
          width: divider.width,
          height: divider.height,
          background: dividerEngaged ? [...DIVIDER_ACTIVE] : undefined,
          cornerRadius: 2,
        }}
        onDrag={actions.devtoolsDividerDrag}
        onMouseEnter={() => actions.devtoolsDividerHover(true)}
        onMouseLeave={() => actions.devtoolsDividerHover(false)}
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

function ToolbarButton({
  icon,
  enabled,
  rem,
  theme,
  onClick,
}: {
  icon: IconName;
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
      <Icon icon={icon} size={rem * 1.1} color={enabled ? theme.muted : theme.disabled} />
    </Box>
  );
}

