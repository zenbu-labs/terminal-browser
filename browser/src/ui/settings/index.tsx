import { useEffect, useState } from "react";
import { Box, Text } from "@zenbu-labs/pixel";
import { Backdrop } from "../modals";
import { Icon } from "../icons";
import type { IconName } from "../icons";
import type { Theme } from "../theme";
import type { ChromeLayout, SettingsActions, SettingsSection, SettingsView } from "../types";
import { copy } from "./copy";
import { RecordDialog } from "./record-dialog";
import { AgentBriefButton } from "./agent-brief-button";
import { IconButton } from "./controls";
import { ShortcutsPane } from "./shortcuts";
import { GeneralPane } from "./general";
import { CUSTOM, DropdownMenu, withCustom } from "./dropdown";
import type { OpenDropdown } from "./dropdown";

const SECTIONS: SettingsSection[] = ["general", "shortcuts", "advanced"];
const SECTION_ICONS: Record<SettingsSection, IconName> = {
  general: "settings",
  shortcuts: "keyboard",
  advanced: "sliders",
};
const SIDEBAR_REMS = 15;
export const PANE_PADDING_REMS = 1.75;
const DROPDOWN_MAX_REMS = 19.5;

export function SettingsCard({
  view,
  actions,
  layout,
  theme,
}: {
  view: SettingsView;
  actions: SettingsActions;
  layout: ChromeLayout;
  theme: Theme;
}) {
  const rem = layout.rem;
  const width = Math.round(
    Math.min(layout.width - rem * 2, Math.max(layout.width * 0.75, rem * 56)),
  );
  const areaTop = layout.toolbarHeight;
  const areaHeight = layout.height - areaTop;
  const height = Math.round(
    Math.min(areaHeight - rem * 1.5, Math.max(areaHeight * 0.75, rem * 30)),
  );
  const top = Math.round(areaTop + (areaHeight - height) / 2);
  const left = Math.round((layout.width - width) / 2);
  const paneWidth = width - rem * SIDEBAR_REMS - 1 - rem * PANE_PADDING_REMS * 2;
  const dropdownWidth = Math.round(Math.min(paneWidth * 0.5, rem * DROPDOWN_MAX_REMS));
  const [menu, setMenu] = useState<OpenDropdown | null>(null);
  const [customKeys, setCustomKeys] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setMenu(null), [view.section]);
  const menuRow = menu && view.settings.find((row) => row.key === menu.key);
  const pick = (key: string, value: string) => {
    const next = new Set(customKeys);
    if (value === CUSTOM) next.add(key);
    else {
      next.delete(key);
      actions.set(key, value);
    }
    setCustomKeys(next);
    setMenu(null);
  };
  return (
    <>
      <Backdrop layout={layout} onClose={actions.close} />
      <Box
        style={{
          position: "absolute",
          inset: { top, left },
          width,
          height,
          flexDirection: "row",
          background: theme.overlay,
          cornerRadius: rem * 0.55,
          border: { width: 1, color: theme.fieldBorder },
          overflow: "hidden",
        }}
        onClick={() => {}}
        onWheel={() => {}}
      >
        <Box
          style={{
            width: rem * SIDEBAR_REMS,
            flexShrink: 0,
            flexDirection: "column",
            border: { right: [1, theme.hairline] },
          }}
        >
          <Box style={{ flexDirection: "column", gap: rem * 0.1, padding: rem * 0.5 }}>
            {SECTIONS.map((section) => {
              const active = section === view.section;
              return (
                <Box
                  key={section}
                  style={{
                    height: rem * 2.2,
                    alignItems: "center",
                    gap: rem * 0.6,
                    padding: { left: rem * 0.75 },
                    cornerRadius: rem * 0.4,
                    background: active ? theme.hover : undefined,
                    hoverBackground: theme.hover,
                  }}
                  onClick={() => actions.section(section)}
                >
                  <Icon icon={SECTION_ICONS[section]} size={rem * 1} color={active ? theme.fg : theme.muted} />
                  <Text
                    style={{
                      fontSize: rem * 0.95,
                      color: active ? theme.fg : theme.muted,
                      wrap: false,
                      selectable: false,
                    }}
                  >
                    {copy.sections[section]}
                  </Text>
                </Box>
              );
            })}
          </Box>
          <Box style={{ flexGrow: 1, flexBasis: 0 }} />
          <Box style={{ padding: rem * 0.5, border: { top: [1, theme.hairline] } }}>
            <AgentBriefButton rem={rem} theme={theme} onCopy={actions.copyAgentBrief} />
          </Box>
        </Box>
        <Box style={{ flexGrow: 1, flexBasis: 0, minWidth: 0, flexDirection: "column" }}>
          <PaneHeader title={copy.sections[view.section]} rem={rem} theme={theme} onClose={actions.close} />
          {view.section === "shortcuts" ? (
            <ShortcutsPane view={view} actions={actions} rem={rem} theme={theme} />
          ) : (
            <GeneralPane
              group={view.section}
              view={view}
              actions={actions}
              menu={menu}
              onOpenDropdown={(key, rect) => setMenu({ key, rect })}
              customKeys={customKeys}
              dropdownWidth={dropdownWidth}
              rem={rem}
              theme={theme}
            />
          )}
        </Box>
        {menu && menuRow && menuRow.kind === "choice" && (
          <DropdownMenu
            choices={menuRow.custom ? withCustom(menuRow.choices) : menuRow.choices}
            value={
              customKeys.has(menuRow.key) || !menuRow.choices.some((choice) => choice.value === menuRow.value)
                ? CUSTOM
                : menuRow.value
            }
            rect={{ ...menu.rect, x: menu.rect.x - left, y: menu.rect.y - top }}
            bounds={{ width, height }}
            rem={rem}
            theme={theme}
            onPick={(value) => pick(menuRow.key, value)}
            onDismiss={() => setMenu(null)}
          />
        )}
      </Box>
      {view.recording && (
        <RecordDialog
          keys={view.recording.keys}
          layout={layout}
          theme={theme}
          onCancel={actions.cancelRecording}
        />
      )}
    </>
  );
}

function PaneHeader({
  title,
  rem,
  theme,
  onClose,
}: {
  title: string;
  rem: number;
  theme: Theme;
  onClose(): void;
}) {
  return (
    <Box
      style={{
        flexShrink: 0,
        alignItems: "center",
        padding: { left: rem * PANE_PADDING_REMS, right: rem * PANE_PADDING_REMS, top: rem * 1.5, bottom: rem * 1.2 },
        border: { bottom: [1, theme.hairline] },
      }}
    >
      <Text style={{ flexGrow: 1, flexBasis: 0, fontSize: rem * 1.2, wrap: false, selectable: false }}>{title}</Text>
      <IconButton icon="close" rem={rem} theme={theme} onClick={onClose} />
    </Box>
  );
}
