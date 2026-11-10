import { Box, Text } from "@zenbu-labs/pixel";
import type { Theme } from "../theme";
import type { SettingsActions, SettingsView } from "../types";
import { copy } from "./copy";
import { TextButton } from "./controls";
import { CopyIcon, useCopiedFlash } from "./copied";
import { PANE_PADDING_REMS } from "./index";

export function ConfigFiles({
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
  return (
    <Box
      style={{
        flexDirection: "column",
        gap: rem * 0.45,
        padding: { top: rem * 1.1, left: rem * PANE_PADDING_REMS, right: rem * PANE_PADDING_REMS },
      }}
    >
      <Text style={{ fontSize: rem * 1, wrap: false, selectable: false }}>{copy.configFiles}</Text>
      <PathLine
        path={view.files.settings}
        rem={rem}
        theme={theme}
        onCopy={() => actions.copyPath("settings")}
      />
      <PathLine
        path={view.files.shortcuts}
        rem={rem}
        theme={theme}
        onCopy={() => actions.copyPath("shortcuts")}
      />
      <Box style={{ margin: { top: rem * 0.3 } }}>
        <TextButton label={copy.reload} rem={rem} theme={theme} onClick={actions.reloadConfig} />
      </Box>
    </Box>
  );
}

function PathLine({
  path,
  rem,
  theme,
  onCopy,
}: {
  path: string;
  rem: number;
  theme: Theme;
  onCopy(): void;
}) {
  const [copied, flash] = useCopiedFlash();
  return (
    <Box style={{ flexDirection: "column" }}>
      <Box style={{ alignItems: "center", gap: rem * 0.5 }}>
        <Text style={{ fontSize: rem * 0.85, color: theme.muted, wrap: false }}>{path}</Text>
        <Box
          style={{
            width: rem * 1.6,
            height: rem * 1.6,
            alignItems: "center",
            justifyContent: "center",
            cornerRadius: rem * 0.3,
            hoverBackground: theme.hover,
          }}
          onClick={() => {
            onCopy();
            flash();
          }}
        >
          <CopyIcon copied={copied} size={rem * 1} theme={theme} />
        </Box>
      </Box>
    </Box>
  );
}
