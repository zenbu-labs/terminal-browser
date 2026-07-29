import { useMemo } from "react";
import { Box, Text } from "pixel-react";
import type { EngineInfo, Surface } from "pixel-react";
import type { BrowserState } from "../page/types";
import { DeviceFrame } from "./device-frame";
import { Icon } from "./icons";
import type { IconName } from "./icons";
import { PageContextMenu } from "./context-menu";
import { NewTabCard, PaletteCard, UrlCard } from "./modals";
import { DownloadHud, FindBar, ZoomHud } from "./overlays";
import { PopupModal } from "./popup-modal";
import { TabStrip } from "./tab-strip";
import { makeTheme } from "./theme";
import type { Theme } from "./theme";
import type {
  ChromeActions,
  ChromeLayout,
  DeviceView,
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
  device,
  tabs,
  newTab,
  urlEdit,
  popup,
  zoomHud,
  download,
  pageMenu,
  dividerEngaged,
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
  device: DeviceView | null;
  tabs: TabRow[];
  newTab: NewTabView | null;
  urlEdit: boolean;
  popup: PopupView | null;
  /** zoom factor to flash in a transient bubble after a cmd+/- press */
  zoomHud: number | null;
  download: DownloadView | null;
  pageMenu: PageMenuView | null;
  dividerEngaged: boolean;
  pageSurface: Surface;
  popupSurface: Surface;
  devtoolsSurface: Surface;
}) {
  const theme = useMemo(() => makeTheme(colors), [colors]);
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
      {layout.toolbarHeight > 0 && (
        <Toolbar state={state} actions={actions} layout={layout} theme={theme} tabs={tabs} />
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
        <BrowserTabContents layout={layout} theme={theme} surface={pageSurface} actions={actions} />
      )}
      {layout.devtools && (
        <DevtoolsPane
          layout={layout}
          theme={theme}
          surface={devtoolsSurface}
          actions={actions}
          dividerEngaged={dividerEngaged}
        />
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
      {urlEdit && <UrlCard state={state} actions={actions} layout={layout} theme={theme} />}
      {palette && <PaletteCard view={palette} actions={actions} layout={layout} theme={theme} />}
    </Box>
  );
}

function Toolbar({
  state,
  actions,
  layout,
  theme,
  tabs,
}: {
  state: BrowserState;
  actions: ChromeActions;
  layout: ChromeLayout;
  theme: Theme;
  tabs: TabRow[];
}) {
  const rem = layout.rem;
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
        icon={state.loading ? "close" : "reload"}
        enabled
        rem={rem}
        theme={theme}
        onClick={actions.reload}
      />
      <TabStrip tabs={tabs} state={state} actions={actions} rem={rem} theme={theme} />
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
}: {
  layout: ChromeLayout;
  theme: Theme;
  surface: Surface;
  actions: ChromeActions;
}) {
  const dock = layout.devtools?.dock ?? null;
  return (
    <>
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
      <Box
        id="browser-surface"
        surface={surface}
        style={{
          position: "absolute",
          inset: { top: layout.page.y, left: layout.page.x },
          width: layout.page.width,
          height: layout.page.height,
          cornerRadius: seamRadius(Math.max(2, layout.rem * 0.55 - 1), dock, "page"),
          background: theme.bg,
        }}
        onPointer={actions.pointer}
        onWheel={actions.wheel}
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
      <Icon icon={icon} size={rem * 0.95} color={enabled ? theme.muted : theme.disabled} />
    </Box>
  );
}

