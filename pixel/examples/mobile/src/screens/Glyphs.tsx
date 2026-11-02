import { Box, Text } from "@zenbu-labs/pixel/device";

import { useMetrics } from "../metrics";
import { colors } from "../theme";
import { Section } from "../ui";

const ROWS = [
  ["Emoji", "🎉 🙂 🚀 🧭 🍜 🌈 🐙 ✨"],
  ["Kaomoji", "(｡•̀ᴗ-)✧  ヽ(・∀・)ﾉ  ¯\\_(ツ)_/¯"],
  ["CJK and more", "世界 こんにちは 안녕 Привет Γειά"],
  ["Symbols", "✓ ✗ → ⌘ ⌥ ⇧ ∑ ∫ ≈ ★ ♪"],
  ["Narrow no-break space", `2:24 PM · 10 000 steps`],
];

export function Glyphs() {
  const { pt } = useMetrics();
  return (
    <Box style={{ flexGrow: 1, flexBasis: 0, overflow: "scroll", flexDirection: "column", padding: { left: 16 * pt, right: 16 * pt, bottom: 40 * pt } }}>
      {ROWS.map(([title, sample]) => (
        <Section key={title} title={title}>
          <Text style={{ color: colors.text, fontSize: 24 * pt }}>{sample}</Text>
        </Section>
      ))}
    </Box>
  );
}
