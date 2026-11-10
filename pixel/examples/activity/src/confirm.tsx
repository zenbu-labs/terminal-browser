import { Box, Text } from "@zenbu-labs/pixel";

import { COPY } from "./copy";
import type { Process } from "./system";
import { Button, Label, mix, useUi } from "./ui";

export function ConfirmEnd({
  process,
  onCancel,
  onEnd,
}: {
  process: Process;
  onCancel(): void;
  onEnd(force: boolean): void;
}) {
  const { rem, theme } = useUi();
  return (
    <Box
      style={{
        position: "absolute",
        inset: { left: 0, top: 0, right: 0, bottom: 0 },
        alignItems: "center",
        justifyContent: "center",
        background: [0, 0, 0, 110],
      }}
    >
      <Box
        style={{
          width: rem * 24,
          flexDirection: "column",
          gap: rem * 0.8,
          padding: rem * 1.2,
          cornerRadius: rem * 0.8,
          background: mix(theme.bg, theme.fg, 0.05),
          border: { width: 1, color: theme.fieldBorder },
        }}
        onClickOutside={onCancel}
      >
        <Label size={1}>{COPY.confirmTitle(process.name)}</Label>
        <Text style={{ fontSize: rem * 0.78, color: theme.muted, wrap: true, selectable: false }}>
          {COPY.confirmBody(process.pid)}
        </Text>
        <Box style={{ gap: rem * 0.5, justifyContent: "end", margin: { top: rem * 0.4 } }}>
          <Button label={COPY.cancel} onClick={onCancel} />
          <Button label={COPY.forceQuit} tone="danger" onClick={() => onEnd(true)} />
          <Button label={COPY.endProcess} tone="primary" onClick={() => onEnd(false)} />
        </Box>
      </Box>
    </Box>
  );
}
