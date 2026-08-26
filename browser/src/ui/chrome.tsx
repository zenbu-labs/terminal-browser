import { useMemo } from "react";
import { Box, Text } from "pixel-react";
import type { EngineInfo, Surface } from "pixel-react";
import type { BrowserState } from "../page/types";
import type { CertificateWarning } from "../page/types";
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
import { makeTheme, mix } from "./theme";
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
  certificateWarning,
  actions,
  layout,
  colors,
  font,
  findOpen,
  palette,
  tabs,
  newTab,
  urlEdit,
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
  certificateWarning: CertificateWarning | null;
  actions: ChromeActions;
  layout: ChromeLayout;
  colors: EngineInfo["colors"];
  font: number;
  findOpen: boolean;
  palette: PaletteView | null;
  tabs: TabRow[];
  newTab: NewTabView | null;
  urlEdit: boolean;
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
        certificateWarning={certificateWarning}
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
  certificateWarning,
}: {
  layout: ChromeLayout;
  theme: Theme;
  surface: Surface;
  actions: ChromeActions;
  interactive: boolean;
  certificateWarning: CertificateWarning | null;
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
      {certificateWarning ? (
        <CertificateWarningPage
          key={`${certificateWarning.url}:${certificateWarning.fingerprint}`}
          warning={certificateWarning}
          layout={layout}
          theme={theme}
          actions={actions}
        />
      ) : (
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
      )}
    </>
  );
}

function CertificateWarningPage({
  warning,
  layout,
  theme,
  actions,
}: {
  warning: CertificateWarning;
  layout: ChromeLayout;
  theme: Theme;
  actions: ChromeActions;
}) {
  const rem = layout.rem;
  const host = certificateHost(warning.url);
  return (
    <Box
      id="certificate-warning"
      style={{
        position: "absolute",
        inset: { top: layout.page.y, left: layout.page.x },
        width: layout.page.width,
        height: layout.page.height,
        flexDirection: "column",
        alignItems: "center",
        overflow: "scroll",
        background: theme.bg,
        padding: {
          left: rem * 1.5,
          right: rem * 1.5,
          top: rem * 2.5,
          bottom: rem * 2.5,
        },
      }}
    >
      <Box style={{ width: "100%", maxWidth: rem * 42, flexDirection: "column", gap: rem }}>
        <Box
          style={{
            width: rem * 3.4,
            height: rem * 3.4,
            alignItems: "center",
            justifyContent: "center",
            cornerRadius: rem * 1.7,
            background: mix(theme.bg, theme.red, 0.22),
            border: { width: 1, color: mix(theme.bg, theme.red, 0.55) },
          }}
        >
          <Text style={{ fontSize: rem * 2.2, color: theme.red, selectable: false }}>!</Text>
        </Box>
        <Text
          style={{ fontSize: rem * 1.75, color: theme.fg, selectable: false }}
          spans={[{ start: 0, end: 30, color: theme.fg, bold: true }]}
        >
          Your connection is not private
        </Text>
        <Text style={{ fontSize: rem, color: theme.muted }}>
          {`The identity of ${host} could not be verified. Attackers might be trying to steal information you send to this site.`}
        </Text>
        <Text style={{ fontSize: rem * 0.82, color: theme.disabled }}>
          {certificateErrorLabel(warning.error)}
        </Text>
        <Box style={{ flexDirection: "column", gap: rem * 0.55, padding: { top: rem * 0.4 } }}>
          <CertificateButton
            label="Back to safety"
            primary
            rem={rem}
            theme={theme}
            onClick={actions.certificateBack}
          />
          <CertificateButton
            label={`Continue to ${host} (unsafe)`}
            rem={rem}
            theme={theme}
            onClick={actions.certificateProceed}
          />
        </Box>
        <Box
          style={{
            flexDirection: "column",
            gap: rem * 0.35,
            margin: { top: rem * 0.6 },
            padding: rem,
            cornerRadius: rem * 0.4,
            background: theme.field,
            border: { width: 1, color: theme.fieldBorder },
          }}
        >
          <CertificateDetail label="Subject" value={warning.subject || "Unknown"} rem={rem} theme={theme} />
          <CertificateDetail label="Issuer" value={warning.issuer || "Unknown"} rem={rem} theme={theme} />
          <CertificateDetail
            label="Valid"
            value={`${certificateDate(warning.validStart)} – ${certificateDate(warning.validExpiry)}`}
            rem={rem}
            theme={theme}
          />
          <CertificateDetail
            label="Fingerprint"
            value={warning.fingerprint || "Unavailable"}
            rem={rem}
            theme={theme}
          />
        </Box>
      </Box>
    </Box>
  );
}

function CertificateButton({
  label,
  primary = false,
  rem,
  theme,
  onClick,
}: {
  label: string;
  primary?: boolean;
  rem: number;
  theme: Theme;
  onClick(): void;
}) {
  return (
    <Box
      style={{
        alignItems: "center",
        justifyContent: "center",
        padding: { left: rem, right: rem, top: rem * 0.55, bottom: rem * 0.55 },
        cornerRadius: rem * 0.35,
        background: primary ? theme.accent : theme.field,
        hoverBackground: primary ? mix(theme.accent, theme.fg, 0.18) : theme.hoverStrong,
        border: primary ? undefined : { width: 1, color: theme.fieldBorder },
      }}
      onClick={onClick}
    >
      <Text style={{ color: primary ? theme.bg : theme.fg, wrap: false, selectable: false }}>
        {label}
      </Text>
    </Box>
  );
}

function CertificateDetail({
  label,
  value,
  rem,
  theme,
}: {
  label: string;
  value: string;
  rem: number;
  theme: Theme;
}) {
  return (
    <Box style={{ flexDirection: "column", gap: rem * 0.12 }}>
      <Text style={{ fontSize: rem * 0.72, color: theme.disabled, selectable: false }}>{label}</Text>
      <Text style={{ fontSize: rem * 0.82, color: theme.muted }}>{value}</Text>
    </Box>
  );
}

function certificateHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function certificateErrorLabel(error: string): string {
  return error.toUpperCase();
}

function certificateDate(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "Unknown";
  return new Date(seconds * 1000).toLocaleDateString();
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
