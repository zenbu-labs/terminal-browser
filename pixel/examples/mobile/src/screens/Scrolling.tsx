import { Box, Text } from "@zenbu-labs/pixel/device";
import { useEffect, useState } from "react";
import { Pixel } from "@zenbu-labs/pixel-ios";

import { useMetrics } from "../metrics";
import { colors } from "../theme";

const LINES = Array.from({ length: 400 }, (_, i) => `${i + 1}. The keeper climbed the ninety-two steps at dusk, wound the clockwork and watched the beam sweep the water.`);

export function Scrolling() {
  const { pt } = useMetrics();
  const [stats, setStats] = useState("");
  useEffect(() => {
    const timer = setInterval(() => {
      const taken = Pixel.frameStats() as { frames?: number; kinds?: Record<string, number>; engineMs?: { p50: number } };
      if (!taken.frames) return;
      const kinds = taken.kinds ?? {};
      const total = Object.values(kinds).reduce((sum, n) => sum + n, 0) || 1;
      const patched = Math.round(((kinds.patched ?? 0) / total) * 100);
      setStats(`${taken.frames} frames · ${patched}% patched · engine ${taken.engineMs?.p50.toFixed(1)} ms`);
    }, 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <Box style={{ flexGrow: 1, flexBasis: 0, flexDirection: "column" }}>
      <Box style={{ flexGrow: 1, flexBasis: 0, overflow: "scroll", flexDirection: "column", padding: { left: 16 * pt, right: 16 * pt, bottom: 120 * pt } }}>
        {LINES.map((line, i) => (
          <Text key={i} style={{ color: i % 10 === 0 ? colors.accent : colors.text, fontSize: 16 * pt, margin: { bottom: 8 * pt } }}>
            {line}
          </Text>
        ))}
      </Box>
      <Box
        style={{
          position: "absolute",
          inset: { left: 0, right: 0, bottom: 0 },
          height: 140 * pt,
          background: { from: [0, 0], to: [0, 1], stops: [{ at: 0, color: [18, 18, 22, 0] }, { at: 0.5, color: [18, 18, 22, 230] }, { at: 1, color: [18, 18, 22, 255] }] },
        }}
      />
      <Box style={{ position: "absolute", inset: { left: 24 * pt, right: 24 * pt, bottom: 34 * pt }, height: 44 * pt, cornerRadius: 22 * pt, background: [40, 40, 48, 220], justifyContent: "center", padding: { left: 18 * pt } }}>
        <Text style={{ color: colors.muted, fontSize: 14 * pt }}>{stats || "scroll to measure frames"}</Text>
      </Box>
    </Box>
  );
}
