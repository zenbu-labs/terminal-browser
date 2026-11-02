import { Box, Text, useSafeArea } from "@zenbu-labs/pixel/device";

import { useMetrics } from "../metrics";
import { colors } from "../theme";

export function SafeArea() {
  const { pt } = useMetrics();
  const insets = useSafeArea();
  const band = (color: [number, number, number, number]) => ({ position: "absolute" as const, background: color });
  return (
    <Box style={{ position: "absolute", inset: { left: 0, right: 0, top: 0, bottom: 0 }, background: { from: [0, 0], to: [1, 1], stops: [{ at: 0, color: [40, 20, 80, 255] }, { at: 1, color: [10, 70, 90, 255] }] } }}>
      <Box style={{ ...band([255, 120, 90, 110]), inset: { left: 0, right: 0, top: 0 }, height: insets.top }} />
      <Box style={{ ...band([255, 120, 90, 110]), inset: { left: 0, right: 0, bottom: 0 }, height: insets.bottom }} />
      <Box style={{ ...band([255, 120, 90, 110]), inset: { left: 0, top: 0, bottom: 0 }, width: insets.left }} />
      <Box style={{ ...band([255, 120, 90, 110]), inset: { right: 0, top: 0, bottom: 0 }, width: insets.right }} />
      <Box style={{ position: "absolute", inset: { left: insets.left + 20 * pt, right: insets.right + 20 * pt, top: insets.top + 70 * pt }, flexDirection: "column", gap: 10 * pt }}>
        <Text style={{ color: colors.text, fontSize: 20 * pt }}>Full bleed</Text>
        <Text style={{ color: colors.text, fontSize: 15 * pt }}>
          pixel draws under the status area and the home indicator. The orange bands are the safe-area insets the host reports, so an app can keep its controls clear.
        </Text>
        <Text style={{ color: colors.muted, fontSize: 15 * pt }}>{`top ${insets.top} · right ${insets.right} · bottom ${insets.bottom} · left ${insets.left} (px)`}</Text>
      </Box>
    </Box>
  );
}
