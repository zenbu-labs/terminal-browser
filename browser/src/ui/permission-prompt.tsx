import { Box, Text } from "@zenbu-labs/pixel";
import { Icon } from "./icons";
import { mix } from "./theme";
import type { Theme } from "./theme";
import type { ChromeActions, ChromeLayout, PermissionDecision, PermissionPromptView } from "./types";

export function PermissionPrompt({
  view,
  actions,
  layout,
  theme,
}: {
  view: PermissionPromptView;
  actions: ChromeActions;
  layout: ChromeLayout;
  theme: Theme;
}) {
  const rem = layout.rem;
  const width = Math.min(rem * 24, layout.width - rem * 2);
  const title = view.host ? `${view.host} wants to` : "This file wants to";
  return (
    <Box
      style={{
        position: "absolute",
        inset: { top: layout.toolbarHeight + rem * 0.9, left: Math.round((layout.width - width) / 2) },
        width,
        flexDirection: "column",
        gap: rem * 0.9,
        padding: { left: rem * 1.2, right: rem * 1.2, top: rem * 1, bottom: rem * 1.1 },
        background: theme.overlay,
        cornerRadius: rem * 0.8,
        border: { width: 1, color: theme.fieldBorder },
      }}
      onClick={() => {}}
    >
      <Box style={{ alignItems: "center", gap: rem * 0.5 }}>
        <Text
          style={{
            flexGrow: 1,
            flexBasis: 0,
            fontSize: rem * 1.15,
            color: theme.fg,
            wrap: false,
            selectable: false,
          }}
        >
          {title}
        </Text>
        <Box
          style={{
            width: rem * 1.5,
            height: rem * 1.5,
            alignItems: "center",
            justifyContent: "center",
            cornerRadius: rem * 0.3,
            hoverBackground: theme.hover,
            flexShrink: 0,
          }}
          onClick={() => actions.permissionDecide("dismiss")}
        >
          <Icon icon="close" size={rem * 1} color={theme.fg} />
        </Box>
      </Box>
      <Box style={{ flexDirection: "column", gap: rem * 0.6 }}>
        {view.items.map((item) => (
          <Box key={item.label} style={{ alignItems: "start", gap: rem * 0.6 }}>
            <Icon icon={item.icon} size={rem * 1.1} color={theme.fg} />
            <Text
              style={{
                flexGrow: 1,
                flexBasis: 0,
                fontSize: rem * 0.95,
                color: theme.fg,
                selectable: false,
              }}
            >
              {item.label}
            </Text>
          </Box>
        ))}
      </Box>
      <Box style={{ justifyContent: "end", gap: rem * 0.6, padding: { top: rem * 0.2 } }}>
        <PillButton label="Block" decision="block" tone="neutral" rem={rem} theme={theme} actions={actions} />
        <PillButton label="Allow" decision="allow" tone="accent" rem={rem} theme={theme} actions={actions} />
      </Box>
    </Box>
  );
}

function PillButton({
  label,
  decision,
  tone,
  rem,
  theme,
  actions,
}: {
  label: string;
  decision: PermissionDecision;
  tone: "neutral" | "accent";
  rem: number;
  theme: Theme;
  actions: ChromeActions;
}) {
  const height = rem * 1.9;
  return (
    <Box
      style={{
        height,
        alignItems: "center",
        padding: { left: rem * 1.1, right: rem * 1.1 },
        cornerRadius: rem * 0.35,
        background: tone === "accent" ? mix(theme.overlay, theme.accent, 0.22) : theme.field,
        hoverBackground: tone === "accent" ? mix(theme.overlay, theme.accent, 0.38) : theme.hoverStrong,
        flexShrink: 0,
      }}
      onClick={() => actions.permissionDecide(decision)}
    >
      <Text
        style={{
          fontSize: rem * 0.95,
          color: theme.fg,
          wrap: false,
          selectable: false,
        }}
      >
        {label}
      </Text>
    </Box>
  );
}
