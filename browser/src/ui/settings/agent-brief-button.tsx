import { Box, Text } from "@zenbu-labs/pixel";
import type { Theme } from "../theme";
import { copy } from "./copy";
import { CopyIcon, useCopiedFlash } from "./copied";

export function AgentBriefButton({
  rem,
  theme,
  onCopy,
}: {
  rem: number;
  theme: Theme;
  onCopy(): void;
}) {
  const [copied, flash] = useCopiedFlash();
  return (
    <Box
      style={{
        alignItems: "center",
        gap: rem * 0.7,
        padding: { left: rem * 0.9, right: rem * 0.7, top: rem * 0.6, bottom: rem * 0.6 },
        cornerRadius: rem * 0.4,
        hoverBackground: theme.hover,
      }}
      onClick={() => {
        onCopy();
        flash();
      }}
    >
      <Text
        style={{
          flexGrow: 1,
          flexBasis: 0,
          fontSize: rem * 0.9,
          color: theme.muted,
          wrap: false,
          ellipsis: true,
          selectable: false,
        }}
      >
        {copy.agent}
      </Text>
      <CopyIcon copied={copied} size={rem * 0.95} theme={theme} />
    </Box>
  );
}
