import { useEffect, useRef, useState } from "react";
import { Box, Input, Text } from "@zenbu-labs/pixel";
import type { NodeHandle } from "@zenbu-labs/pixel";
import { Icon } from "../icons";
import { withAlpha } from "../theme";
import type { Theme } from "../theme";
import type { SettingsActions, SettingsView, ShortcutRow } from "../types";
import { copy } from "./copy";
import { ScrollPane } from "./scroll-pane";
import { IconButton } from "./controls";
import { PANE_PADDING_REMS } from "./index";

export function ShortcutsPane({
  view,
  actions,
  rem,
  theme,
}: {
  view: SettingsView;
  actions: SettingsActions;
  rem: number;
  theme: Theme;
}) {
  const input = useRef<NodeHandle | null>(null);
  // Recording needs every key to reach the session, so the search box lets go of focus.
  useEffect(() => {
    if (view.recording) input.current?.blur();
    else input.current?.focus();
  }, [view.recording]);
  return (
    <>
      <Box
        style={{
          height: rem * 2.6,
          flexShrink: 0,
          alignItems: "center",
          gap: rem * 0.5,
          padding: { left: rem * PANE_PADDING_REMS, right: rem * PANE_PADDING_REMS },
          border: { bottom: [1, theme.hairline] },
        }}
      >
        <Icon icon="search" size={rem * 1} color={theme.muted} />
        <Input
          ref={input}
          autoFocus
          style={{ flexGrow: 1, flexBasis: 0, wrap: false, fontSize: rem * 0.95 }}
          caretColor={theme.accent}
          selectionColor={theme.selection}
          onChange={(text) => actions.query(text)}
        />
      </Box>
      <ScrollPane
        rem={rem}
        resetKey={view.shortcuts.length}
        style={{
          flexGrow: 1,
          flexBasis: 0,
          flexDirection: "column",
          padding: { top: rem * 0.4, bottom: rem * 0.4 },
        }}
      >
        {view.shortcuts.length === 0 && (
          <Text
            style={{
              padding: { left: rem * PANE_PADDING_REMS, top: rem * 0.4 },
              fontSize: rem * 0.9,
              color: theme.muted,
              selectable: false,
            }}
          >
            {copy.noMatches}
          </Text>
        )}
        {view.shortcuts.map((row) => (
          <ShortcutLine
            key={row.id}
            row={row}
            recording={view.recording?.id === row.id}
            actions={actions}
            rem={rem}
            theme={theme}
          />
        ))}
      </ScrollPane>
    </>
  );
}

function ShortcutLine({
  row,
  recording,
  actions,
  rem,
  theme,
}: {
  row: ShortcutRow;
  recording: boolean;
  actions: SettingsActions;
  rem: number;
  theme: Theme;
}) {
  const [hover, setHover] = useState(false);
  const toggleRecord = () =>
    recording ? actions.cancelRecording() : actions.recordShortcut(row.id);
  return (
    <Box
      style={{
        height: rem * 2.15,
        flexShrink: 0,
        alignItems: "center",
        gap: rem * 0.4,
        padding: { left: rem * PANE_PADDING_REMS, right: rem * PANE_PADDING_REMS },
        hoverBackground: theme.hover,
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Text
        style={{
          flexGrow: 1,
          flexBasis: 0,
          fontSize: rem * 0.92,
          wrap: false,
          selectable: false,
        }}
      >
        {row.label}
      </Text>
      {row.conflicts.length > 0 && !recording && (
        <Text
          style={{ fontSize: rem * 0.75, color: theme.yellow, wrap: false, selectable: false }}
        >
          {copy.conflict(row.conflicts)}
        </Text>
      )}
      {row.keys.length === 0 ? (
        <Chip text={copy.unbound} tone="muted" rem={rem} theme={theme} onClick={toggleRecord} />
      ) : (
        row.keys.map((key) => (
          <Chip
            key={key}
            text={key}
            tone={row.modified ? "modified" : "default"}
            rem={rem}
            theme={theme}
            onClick={toggleRecord}
          />
        ))
      )}
      <Box style={{ width: rem * (row.modified ? 2.65 : 1.25), flexShrink: 0, gap: rem * 0.15 }}>
        {row.modified && (
          <IconButton
            icon="reload"
            rem={rem}
            theme={theme}
            onClick={() => actions.resetShortcut(row.id)}
          />
        )}
        {hover && !recording && row.keys.length > 0 && (
          <IconButton
            icon="close"
            rem={rem}
            theme={theme}
            onClick={() => actions.unbindShortcut(row.id)}
          />
        )}
      </Box>
    </Box>
  );
}

function Chip({
  text,
  tone,
  rem,
  theme,
  onClick,
}: {
  text: string;
  tone: "default" | "modified" | "muted";
  rem: number;
  theme: Theme;
  onClick(): void;
}) {
  const border = tone === "modified" ? withAlpha(theme.accent, 150) : theme.fieldBorder;
  const color = tone === "muted" ? theme.disabled : theme.fg;
  return (
    <Box
      style={{
        height: rem * 1.35,
        flexShrink: 0,
        alignItems: "center",
        padding: { left: rem * 0.45, right: rem * 0.45 },
        cornerRadius: rem * 0.3,
        background: theme.field,
        hoverBackground: theme.hoverStrong,
        border: { width: 1, color: border },
      }}
      onClick={onClick}
    >
      <Text style={{ fontSize: rem * 0.78, color, wrap: false, selectable: false }}>{text}</Text>
    </Box>
  );
}
