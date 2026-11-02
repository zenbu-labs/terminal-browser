import { Box, Text } from "@zenbu-labs/pixel/device";
import type { ReactNode } from "react";
import type { Style } from "@zenbu-labs/pixel/device";

import { useMetrics } from "./metrics";
import { colors } from "./theme";

export function Button({ label, onPress, style }: { label: string; onPress(): void; style?: Style }) {
  const { pt } = useMetrics();
  return (
    <Box
      onClick={onPress}
      style={{ height: 44 * pt, padding: { left: 18 * pt, right: 18 * pt }, flexDirection: "row", alignItems: "center", cornerRadius: 22 * pt, background: colors.accent, ...style }}
    >
      <Text style={{ color: [255, 255, 255, 255], fontSize: 16 * pt }}>{label}</Text>
    </Box>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  const { pt } = useMetrics();
  return (
    <Box style={{ flexDirection: "column", gap: 10 * pt, padding: { top: 18 * pt } }}>
      <Text style={{ color: colors.muted, fontSize: 13 * pt }}>{title.toUpperCase()}</Text>
      {children}
    </Box>
  );
}
