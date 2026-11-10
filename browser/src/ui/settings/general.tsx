import { useState } from "react";
import { Box, Input, Text } from "@zenbu-labs/pixel";
import type { Rect } from "@zenbu-labs/pixel";
import { withAlpha } from "../theme";
import type { Theme } from "../theme";
import type { ReleaseView, SettingGroup, SettingRow, SettingsActions, SettingsView } from "../types";
import { ScrollPane } from "./scroll-pane";
import { IconButton, Toggle } from "./controls";
import { CUSTOM, Dropdown, withCustom } from "./dropdown";
import type { OpenDropdown } from "./dropdown";
import { PANE_PADDING_REMS } from "./index";
import { copy } from "./copy";
import { ConfigFiles } from "./config-files";

export function GeneralPane({
  group,
  view,
  actions,
  menu,
  onOpenDropdown,
  customKeys,
  dropdownWidth,
  rem,
  theme,
}: {
  group: SettingGroup;
  view: SettingsView;
  actions: SettingsActions;
  menu: OpenDropdown | null;
  onOpenDropdown(key: string, rect: Rect): void;
  customKeys: ReadonlySet<string>;
  dropdownWidth: number;
  rem: number;
  theme: Theme;
}) {
  const rows = view.settings.filter((row) => row.group === group);
  return (
    <ScrollPane
      rem={rem}
      resetKey={rows.length}
      style={{ flexGrow: 1, flexBasis: 0, flexDirection: "column", padding: { bottom: rem * 1 } }}
    >
      {group === "general" && <VersionLine release={view.release} rem={rem} theme={theme} />}
      {rows.map((row, index) => (
        <SettingLine
          key={row.key}
          row={row}
          last={group !== "general" && index === rows.length - 1}
          actions={actions}
          menu={menu}
          onOpenDropdown={onOpenDropdown}
          customPicked={customKeys.has(row.key)}
          dropdownWidth={dropdownWidth}
          rem={rem}
          theme={theme}
        />
      ))}
      {group === "general" && <ConfigFiles view={view} actions={actions} rem={rem} theme={theme} />}
    </ScrollPane>
  );
}

function VersionLine({ release, rem, theme }: { release: ReleaseView; rem: number; theme: Theme }) {
  return (
    <Box
      style={{
        flexDirection: "column",
        flexShrink: 0,
        gap: rem * 0.45,
        padding: { left: rem * PANE_PADDING_REMS, right: rem * PANE_PADDING_REMS, top: rem * 1.1, bottom: rem * 1.1 },
        border: { bottom: [1, theme.hairline] },
      }}
    >
      <Box style={{ alignItems: "center", gap: rem * 0.6 }}>
        <Text style={{ flexGrow: 1, flexBasis: 0, fontSize: rem * 1, wrap: false, selectable: false }}>
          {copy.version}
        </Text>
        <Text style={{ fontSize: rem * 0.9, color: theme.muted, wrap: false, selectable: true }}>{release.version}</Text>
      </Box>
      {release.latest && (
        <Text style={{ fontSize: rem * 0.85, color: theme.green, selectable: false }}>
          {copy.update(release.latest, release.upgrade)}
        </Text>
      )}
    </Box>
  );
}

export function SettingLine({
  row,
  last,
  actions,
  menu,
  onOpenDropdown,
  customPicked,
  dropdownWidth,
  rem,
  theme,
}: {
  row: SettingRow;
  last: boolean;
  actions: SettingsActions;
  menu: OpenDropdown | null;
  onOpenDropdown(key: string, rect: Rect): void;
  customPicked: boolean;
  dropdownWidth: number;
  rem: number;
  theme: Theme;
}) {
  const [hover, setHover] = useState(false);
  const preset = row.kind === "choice" && row.choices.some((choice) => choice.value === row.value);
  const customShown = row.kind === "choice" && row.custom && (customPicked || !preset);
  const showReset = row.modified && (hover || row.group === "advanced");
  const reset = (
    <Box style={{ width: rem * 1.6, height: rem * 1.6, flexShrink: 0 }}>
      {showReset && <IconButton icon="reload" rem={rem} theme={theme} onClick={() => actions.reset(row.key)} />}
    </Box>
  );
  return (
    <Box
      style={{
        flexDirection: "column",
        flexShrink: 0,
        minWidth: 0,
        gap: rem * 0.45,
        padding: { left: rem * PANE_PADDING_REMS, right: rem * PANE_PADDING_REMS, top: rem * 1.1, bottom: rem * 1.1 },
        border: last ? undefined : { bottom: [1, theme.hairline] },
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Box style={{ alignItems: "center", gap: rem * 0.6 }}>
        <Text style={{ flexGrow: 1, flexBasis: 0, fontSize: rem * 1, wrap: false, selectable: false }}>
          {row.label}
        </Text>
        {reset}
        {row.kind === "toggle" && (
          <Toggle
            on={(row.value === "on") !== row.inverted}
            rem={rem}
            theme={theme}
            onChange={(on) => actions.set(row.key, on !== row.inverted ? "on" : "off")}
          />
        )}
        {row.kind === "choice" && (
          <Dropdown
            choices={row.custom ? withCustom(row.choices) : row.choices}
            value={customShown || !preset ? CUSTOM : row.value}
            open={menu?.key === row.key}
            width={dropdownWidth}
            rem={rem}
            theme={theme}
            onOpen={(rect) => onOpenDropdown(row.key, rect)}
          />
        )}
        {row.kind === "string" && (
          <TemplateField row={row} actions={actions} width={dropdownWidth} rem={rem} theme={theme} />
        )}
      </Box>
      <Text style={{ fontSize: rem * 0.85, color: theme.muted, selectable: false }}>{row.hint}</Text>
      {customShown && (
        <Box style={{ justifyContent: "end" }}>
          <TemplateField row={row} actions={actions} width={dropdownWidth} rem={rem} theme={theme} />
        </Box>
      )}
    </Box>
  );
}

function TemplateField({
  row,
  actions,
  width,
  rem,
  theme,
}: {
  row: SettingRow & { value: string };
  actions: SettingsActions;
  width: number;
  rem: number;
  theme: Theme;
}) {
  return (
    <Box
      style={{
        width,
        height: rem * 2.1,
        alignItems: "center",
        padding: { left: rem * 0.7, right: rem * 0.7 },
        cornerRadius: rem * 0.35,
        background: theme.field,
        border: { width: 1, color: row.modified ? withAlpha(theme.accent, 150) : theme.fieldBorder },
      }}
    >
      <Input
        key={row.value}
        defaultValue={row.value}
        style={{ flexGrow: 1, flexBasis: 0, wrap: false, fontSize: rem * 0.9 }}
        caretColor={theme.accent}
        selectionColor={theme.selection}
        onChange={(text) => actions.draft(row.key, text)}
        onSubmit={(text) => actions.set(row.key, text)}
      />
    </Box>
  );
}
