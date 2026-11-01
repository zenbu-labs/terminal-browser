import { Box, Image, Text } from "@zenbu-labs/pixel";
import { Backdrop } from "./modals";
import { mix } from "./theme";
import type { Theme } from "./theme";
import type { ExtensionsView } from "./extension-types";
import type { ChromeLayout } from "./types";

type Prompt = NonNullable<ExtensionsView["prompt"]>;

function copy(prompt: Prompt): { title: string; confirm: string; danger: boolean } {
  switch (prompt.kind) {
    case "install":
      return { title: `Add "${prompt.name}"?`, confirm: "Add extension", danger: false };
    case "permissions":
      return { title: `"${prompt.name}" wants to:`, confirm: "Allow", danger: false };
    case "update":
      return { title: `"${prompt.name}" needs new permissions`, confirm: "Allow", danger: false };
    case "remove":
      return { title: `Remove "${prompt.name}"?`, confirm: "Remove", danger: true };
  }
}

const CANCEL = "Cancel";

export function ExtensionPrompt({
  prompt,
  layout,
  theme,
  onAnswer,
}: {
  prompt: Prompt;
  layout: ChromeLayout;
  theme: Theme;
  onAnswer(accepted: boolean): void;
}) {
  const rem = layout.rem;
  const width = Math.min(rem * 26, layout.width - rem * 2);
  const { title, confirm, danger } = copy(prompt);
  const iconSize = Math.round(rem * 1.6);
  return (
    <>
      <Backdrop layout={layout} onClose={() => {}} />
      <Box
        style={{
          position: "absolute",
          inset: { top: layout.toolbarHeight + rem * 0.9, left: Math.round((layout.width - width) / 2) },
          width,
          flexDirection: "column",
          gap: rem * 0.9,
          padding: { left: rem * 1.2, right: rem * 1.2, top: rem * 1.1, bottom: rem * 1.1 },
          background: theme.overlay,
          cornerRadius: rem * 0.8,
          border: { width: 1, color: theme.fieldBorder },
        }}
        onClick={() => {}}
      >
        <Box style={{ alignItems: "center", gap: rem * 0.75 }}>
          {prompt.icon && (
            <Image
              src={prompt.icon}
              error={<Box style={{ width: iconSize, height: iconSize, flexShrink: 0 }} />}
              style={{ width: iconSize, height: iconSize, flexShrink: 0 }}
            />
          )}
          <Text style={{ flexGrow: 1, flexBasis: 0, fontSize: rem * 1.1, color: theme.fg, selectable: false }}>{title}</Text>
        </Box>
        {prompt.warnings.length > 0 && (
          <Box style={{ flexDirection: "column", gap: rem * 0.45, padding: { left: prompt.icon ? iconSize + rem * 0.75 : 0 } }}>
            {prompt.warnings.map((warning) => (
              <Text key={warning} style={{ fontSize: rem * 0.9, color: theme.muted, selectable: false }}>
                {warning}
              </Text>
            ))}
          </Box>
        )}
        <Box style={{ justifyContent: "end", gap: rem * 0.6, padding: { top: rem * 0.2 } }}>
          <PromptButton label={CANCEL} tone="neutral" rem={rem} theme={theme} onClick={() => onAnswer(false)} />
          <PromptButton label={confirm} tone={danger ? "danger" : "accent"} rem={rem} theme={theme} onClick={() => onAnswer(true)} />
        </Box>
      </Box>
    </>
  );
}

function PromptButton({
  label,
  tone,
  rem,
  theme,
  onClick,
}: {
  label: string;
  tone: "neutral" | "accent" | "danger";
  rem: number;
  theme: Theme;
  onClick(): void;
}) {
  const tint = tone === "accent" ? theme.accent : tone === "danger" ? theme.red : null;
  return (
    <Box
      style={{
        height: rem * 1.9,
        alignItems: "center",
        padding: { left: rem * 1.1, right: rem * 1.1 },
        cornerRadius: rem * 0.35,
        background: tint ? mix(theme.overlay, tint, tone === "danger" ? 0.3 : 0.22) : theme.field,
        hoverBackground: tint ? mix(theme.overlay, tint, tone === "danger" ? 0.5 : 0.38) : theme.hoverStrong,
        flexShrink: 0,
      }}
      onClick={onClick}
    >
      <Text style={{ fontSize: rem * 0.95, color: theme.fg, wrap: false, selectable: false }}>{label}</Text>
    </Box>
  );
}
