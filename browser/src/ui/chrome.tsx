import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Input, Text } from "pixel-react";
import type { EngineInfo, NodeHandle, Surface } from "pixel-react";
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
import { makeTheme, mix } from "./theme";
import type { Theme } from "./theme";
import type { RecordView } from "../record/types";
import type {
  ChromeActions,
  ChromeLayout,
  DownloadView,
  ImportHintView,
  NewTabView,
  PageMenuView,
  PaletteView,
  PopupView,
  ProfileMenuView,
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
  popup,
  zoomHud,
  download,
  toast,
  pageMenu,
  importHint,
  profiles,
  focusMode,
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
  popup: PopupView | null;
  zoomHud: number | null;
  download: DownloadView | null;
  toast: { text: string; detail?: string; failed: boolean; alert: boolean } | null;
  pageMenu: PageMenuView | null;
  importHint: ImportHintView;
  profiles: ProfileMenuView;
  focusMode: boolean;
  dividerEngaged: boolean;
  record: RecordView | null;
  recordSurface: Surface | null;
  pageSurface: Surface;
  popupSurface: Surface;
  devtoolsSurface: Surface;
}) {
  const theme = useMemo(() => makeTheme(colors), [colors]);
  const activeName = profiles.activeSlug === "default" ? null : profiles.activeName;
  // the person chip carries the name only off the built-in default, cut to what the row affords
  const label =
    activeName !== null && activeName.length > PROFILE_LABEL_MAX
      ? `${activeName.slice(0, PROFILE_LABEL_MAX - 1).trimEnd()}…`
      : activeName;
  const fit =
    layout.toolbarHeight > 0 && !record?.stopped
      ? clusterFit(layout, {
          nav: state.canGoBack || state.canGoForward,
          pill: record !== null,
          offered: importHint.offered,
          label,
        })
      : CLUSTER_HIDDEN;
  const chipLabel = fit.profileName ? label : null;
  // the hint's right edge meets the import chip's, so it clears everything sitting to that chip's right
  const importGutter = layout.rem * (5.9 + profileChipRem(chipLabel));
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
            fit={fit}
            importHint={importHint}
            profiles={profiles}
            profileLabel={chipLabel}
            focusMode={focusMode}
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
      {importHint.open && fit.importChip !== "hidden" && (
        <ImportHintPopover
          view={importHint}
          actions={actions}
          layout={layout}
          theme={theme}
          gutter={importGutter}
        />
      )}
      {profiles.open && fit.shown && (
        <ProfileMenuPopover view={profiles} actions={actions} layout={layout} theme={theme} />
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
  fit,
  importHint,
  profiles,
  profileLabel,
  focusMode,
}: {
  state: BrowserState;
  actions: ChromeActions;
  layout: ChromeLayout;
  theme: Theme;
  tabs: TabRow[];
  record: RecordView | null;
  fit: ClusterFit;
  importHint: ImportHintView;
  profiles: ProfileMenuView;
  profileLabel: string | null;
  focusMode: boolean;
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
      {fit.shown && (
        <>
          {fit.importChip !== "hidden" && (
            <ImportChip
              labelled={fit.importChip === "labelled"}
              open={importHint.open}
              rem={rem}
              theme={theme}
              onClick={actions.importHintToggle}
            />
          )}
          <ToolbarButton
            icon="keyboard"
            enabled
            active={focusMode}
            rem={rem}
            theme={theme}
            onClick={actions.focusModeToggle}
          />
          <ToolbarButton
            icon="camera"
            enabled
            rem={rem}
            theme={theme}
            onClick={actions.screenshotPage}
          />
          <ProfileChip
            label={profileLabel}
            offDefault={profiles.activeSlug !== "default"}
            open={profiles.open}
            rem={rem}
            theme={theme}
            onClick={actions.profileMenuToggle}
          />
          <ToolbarButton
            icon="wrench"
            enabled
            active={layout.devtools !== null}
            rem={rem}
            theme={theme}
            onClick={actions.devtoolsToggle}
          />
        </>
      )}
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
  active = false,
  rem,
  theme,
  onClick,
}: {
  icon: IconName;
  enabled: boolean;
  active?: boolean;
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
        background: active ? theme.field : undefined,
        hoverBackground: enabled ? theme.hover : undefined,
        flexShrink: 0,
      }}
      onClick={enabled ? onClick : undefined}
    >
      <Icon
        icon={icon}
        size={rem * 1.1}
        color={!enabled ? theme.disabled : active ? theme.fg : theme.muted}
      />
    </Box>
  );
}

interface ClusterFit {
  /** whether the right-hand cluster fits at all */
  shown: boolean;
  importChip: "labelled" | "icon" | "hidden";
  /** whether the active profile's name fits beside the person glyph */
  profileName: boolean;
}

const CLUSTER_HIDDEN: ClusterFit = { shown: false, importChip: "hidden", profileName: false };

/**
 * How much of the right-hand cluster fits. Widths are in rem units: the row's own padding, the
 * navigation buttons, the record pill, the four icon buttons at rem*1.5 plus their rem*0.25 gaps,
 * and the narrowest tab strip still worth keeping. What is left buys the import chip's label first,
 * then the active profile's name beside the person glyph.
 */
function clusterFit(
  layout: ChromeLayout,
  row: { nav: boolean; pill: boolean; offered: boolean; label: string | null },
): ClusterFit {
  const free =
    layout.width / layout.rem -
    0.8 -
    (row.nav ? 3 : 1) * 1.75 -
    (row.pill ? 7.5 : 0) -
    4 * 1.75 -
    8;
  if (free < 0) return CLUSTER_HIDDEN;
  const importChip = !row.offered
    ? "hidden"
    : free >= 4.7
      ? "labelled"
      : free >= 1.75
        ? "icon"
        : "hidden";
  // an offered hint holds its widest claim whatever tier it lands on, so the name never flickers
  // back and forth as the pane grows and the Import label appears
  const name = row.label === null ? 0 : profileChipRem(row.label) - 1.5;
  return {
    shown: true,
    importChip,
    profileName: name > 0 && free - (row.offered ? 4.7 : 0) >= name,
  };
}

const PROFILE_LABEL_MAX = 10;

/** The person chip's width in rem: a bare glyph, or its padding, glyph, gap and label. */
function profileChipRem(label: string | null): number {
  return label === null ? 1.5 : 2.25 + label.length * 0.432;
}

function ImportChip({
  labelled,
  open,
  rem,
  theme,
  onClick,
}: {
  labelled: boolean;
  open: boolean;
  rem: number;
  theme: Theme;
  onClick(): void;
}) {
  // while the popover is open its outside-click dismissal closes it, so the chip must not re-toggle
  const click = open ? undefined : onClick;
  return (
    <Box
      style={{
        width: labelled ? undefined : rem * 1.5,
        height: rem * 1.5,
        alignItems: "center",
        justifyContent: "center",
        gap: labelled ? rem * 0.35 : 0,
        padding: labelled ? { left: rem * 0.4, right: rem * 0.4 } : undefined,
        cornerRadius: rem * 0.3,
        background: open ? theme.field : undefined,
        hoverBackground: theme.hover,
        flexShrink: 0,
      }}
      onClick={click}
    >
      <Icon icon="download" size={rem * 0.95} color={theme.muted} />
      {labelled && (
        <Text style={{ fontSize: rem * 0.72, color: theme.fg, wrap: false, selectable: false }}>
          Import
        </Text>
      )}
    </Box>
  );
}

function ImportHintPopover({
  view,
  actions,
  layout,
  theme,
  gutter,
}: {
  view: ImportHintView;
  actions: ChromeActions;
  layout: ChromeLayout;
  theme: Theme;
  gutter: number;
}) {
  const rem = layout.rem;
  const width = Math.min(rem * 17, layout.width - gutter - rem * 0.8);
  return (
    <Box
      style={{
        position: "absolute",
        inset: { top: layout.toolbarHeight + rem * 0.15, right: gutter },
        width,
        flexDirection: "column",
        padding: rem * 0.55,
        gap: rem * 0.3,
        background: mix(theme.bg, [0, 0, 0, 255], 0.25),
        cornerRadius: rem * 0.35,
        border: { width: 1, color: theme.fieldBorder },
      }}
      onClickOutside={actions.importHintToggle}
    >
      <Text style={{ fontSize: rem * 0.8, color: theme.fg, wrap: false, selectable: false }}>
        Import browser data
      </Text>
      <Text style={{ fontSize: rem * 0.72, color: theme.muted, selectable: false }}>
        {view.summary}
      </Text>
      <Text style={{ fontSize: rem * 0.64, color: theme.disabled, selectable: false }}>
        You can always find this in the command palette.
      </Text>
      <Box style={{ alignItems: "center", gap: rem * 0.35, margin: { top: rem * 0.15 } }}>
        <HintButton label="Import…" primary rem={rem} theme={theme} onClick={actions.importRun} />
        <HintButton
          label="Hide Hint"
          rem={rem}
          theme={theme}
          onClick={actions.importHintDismiss}
        />
      </Box>
    </Box>
  );
}

function HintButton({
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
        height: rem * 1.4,
        alignItems: "center",
        justifyContent: "center",
        padding: { left: rem * 0.5, right: rem * 0.5 },
        cornerRadius: rem * 0.25,
        background: primary ? theme.field : undefined,
        border: primary ? { width: 1, color: theme.fieldBorder } : undefined,
        hoverBackground: theme.hover,
        flexShrink: 0,
      }}
      onClick={onClick}
    >
      <Text
        style={{
          fontSize: rem * 0.72,
          color: primary ? theme.fg : theme.muted,
          wrap: false,
          selectable: false,
        }}
      >
        {label}
      </Text>
    </Box>
  );
}

function ProfileChip({
  label,
  offDefault,
  open,
  rem,
  theme,
  onClick,
}: {
  label: string | null;
  offDefault: boolean;
  open: boolean;
  rem: number;
  theme: Theme;
  onClick(): void;
}) {
  // while the popover is open its outside-click dismissal closes it, so the chip must not re-toggle
  const click = open ? undefined : onClick;
  return (
    <Box
      style={{
        width: label === null ? rem * 1.5 : undefined,
        height: rem * 1.5,
        alignItems: "center",
        justifyContent: "center",
        gap: label === null ? 0 : rem * 0.35,
        padding: label === null ? undefined : { left: rem * 0.4, right: rem * 0.4 },
        cornerRadius: rem * 0.3,
        background: open ? theme.field : undefined,
        hoverBackground: theme.hover,
        flexShrink: 0,
      }}
      onClick={click}
    >
      <Icon icon="person" size={rem * 1.1} color={offDefault ? theme.fg : theme.muted} />
      {label !== null && (
        <Text style={{ fontSize: rem * 0.72, color: theme.fg, wrap: false, selectable: false }}>
          {label}
        </Text>
      )}
    </Box>
  );
}

function ProfileMenuPopover({
  view,
  actions,
  layout,
  theme,
}: {
  view: ProfileMenuView;
  actions: ChromeActions;
  layout: ChromeLayout;
  theme: Theme;
}) {
  const rem = layout.rem;
  // right edge meets the person chip's: the devtools button, its gap, and the row's right padding
  const gutter = rem * 2.15;
  const width = Math.min(rem * 16, layout.width - gutter - rem * 0.8);
  return (
    <Box
      style={{
        position: "absolute",
        inset: { top: layout.toolbarHeight + rem * 0.15, right: gutter },
        width,
        flexDirection: "column",
        padding: rem * 0.55,
        gap: rem * 0.3,
        background: mix(theme.bg, [0, 0, 0, 255], 0.25),
        cornerRadius: rem * 0.35,
        border: { width: 1, color: theme.fieldBorder },
      }}
      onClickOutside={actions.profileMenuToggle}
    >
      <Text style={{ fontSize: rem * 0.72, color: theme.muted, wrap: false, selectable: false }}>
        Profiles
      </Text>
      <Box style={{ flexDirection: "column" }}>
        {view.items.map((item) => (
          <ProfileRow
            key={item.slug}
            item={item}
            rem={rem}
            theme={theme}
            onClick={() => actions.profileSwitch(item.slug)}
          />
        ))}
      </Box>
      <Box style={{ height: 1, background: theme.hairline }} />
      {view.prompt ? (
        <ProfileNamePrompt
          key={view.prompt.kind}
          prompt={view.prompt}
          actions={actions}
          rem={rem}
          theme={theme}
        />
      ) : (
        <Box style={{ flexDirection: "column" }}>
          <ProfileAction
            label="New Profile..."
            rem={rem}
            theme={theme}
            onClick={() => actions.profileCreate()}
          />
          {view.activeSlug !== "default" && (
            <ProfileAction
              label="Rename Current Profile..."
              rem={rem}
              theme={theme}
              onClick={() => actions.profileRename()}
            />
          )}
        </Box>
      )}
    </Box>
  );
}

function ProfileRow({
  item,
  rem,
  theme,
  onClick,
}: {
  item: ProfileMenuView["items"][number];
  rem: number;
  theme: Theme;
  onClick(): void;
}) {
  return (
    <Box
      style={{
        height: rem * 1.55,
        alignItems: "center",
        gap: rem * 0.45,
        padding: { left: rem * 0.35, right: rem * 0.35 },
        cornerRadius: rem * 0.25,
        background: item.active ? theme.field : undefined,
        hoverBackground: theme.hover,
        flexShrink: 0,
      }}
      onClick={onClick}
    >
      {item.active ? (
        <Icon icon="record" size={rem * 0.5} color={theme.accent} weight={5} />
      ) : (
        <Box style={{ width: rem * 0.5, flexShrink: 0 }} />
      )}
      <Text
        style={{
          flexGrow: 1,
          flexBasis: 0,
          fontSize: rem * 0.82,
          color: item.active ? theme.fg : theme.muted,
          wrap: false,
          selectable: false,
          overflow: "hidden",
        }}
      >
        {item.name}
      </Text>
    </Box>
  );
}

function ProfileAction({
  label,
  rem,
  theme,
  onClick,
}: {
  label: string;
  rem: number;
  theme: Theme;
  onClick(): void;
}) {
  return (
    <Box
      style={{
        height: rem * 1.55,
        alignItems: "center",
        // the left pad clears the active marker so the labels line up with the profile names
        padding: { left: rem * 1.3, right: rem * 0.35 },
        cornerRadius: rem * 0.25,
        hoverBackground: theme.hover,
        flexShrink: 0,
      }}
      onClick={onClick}
    >
      <Text style={{ fontSize: rem * 0.82, color: theme.fg, wrap: false, selectable: false }}>
        {label}
      </Text>
    </Box>
  );
}

function ProfileNamePrompt({
  prompt,
  actions,
  rem,
  theme,
}: {
  prompt: NonNullable<ProfileMenuView["prompt"]>;
  actions: ChromeActions;
  rem: number;
  theme: Theme;
}) {
  const creating = prompt.kind === "create";
  const [value, setValue] = useState(prompt.text);
  const input = useRef<NodeHandle | null>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.selectAll();
  }, []);
  const submit = (text: string) => {
    if (creating) actions.profileCreate(text);
    else actions.profileRename(text);
  };
  return (
    <Box style={{ flexDirection: "column", gap: rem * 0.25 }}>
      <Text style={{ fontSize: rem * 0.8, color: theme.fg, wrap: false, selectable: false }}>
        {creating ? "New Browser Profile" : "Rename Browser Profile"}
      </Text>
      <Text style={{ fontSize: rem * 0.64, color: theme.disabled, selectable: false }}>
        {creating
          ? "Create a separate browser profile for cookies, history, and local storage."
          : "Choose a new name for this browser profile."}
      </Text>
      <Box style={{ alignItems: "center", gap: rem * 0.35, margin: { top: rem * 0.15 } }}>
        <Box
          style={{
            flexGrow: 1,
            flexBasis: 0,
            height: rem * 1.4,
            alignItems: "center",
            padding: { left: rem * 0.45, right: rem * 0.45 },
            cornerRadius: rem * 0.25,
            background: theme.field,
            border: { width: 1, color: theme.fieldBorder },
          }}
        >
          <Input
            ref={input}
            autoFocus
            value={value}
            style={{ flexGrow: 1, flexBasis: 0, wrap: false, fontSize: rem * 0.8 }}
            caretColor={theme.accent}
            selectionColor={theme.selection}
            onChange={setValue}
            onSubmit={submit}
          />
          {value === "" && (
            <Box
              style={{
                position: "absolute",
                // insets sit inside the border, so the field's own left padding is repeated here
                inset: { left: rem * 0.45, top: 0, bottom: 0 },
                alignItems: "center",
              }}
            >
              <Text
                style={{
                  fontSize: rem * 0.8,
                  color: theme.disabled,
                  wrap: false,
                  selectable: false,
                }}
              >
                Profile name
              </Text>
            </Box>
          )}
        </Box>
        <HintButton
          label={creating ? "Create" : "Rename"}
          primary
          rem={rem}
          theme={theme}
          onClick={() => submit(value)}
        />
      </Box>
    </Box>
  );
}
