import { Box, Text, useSafeArea } from "@zenbu-labs/pixel/device";
import type { DeviceRoot } from "@zenbu-labs/pixel/device";
import { useState } from "react";
import type { ComponentType } from "react";

import { MetricsContext, useMetrics } from "./metrics";
import { Controls } from "./screens/Controls";
import { Crashes } from "./screens/Crashes";
import { Glyphs } from "./screens/Glyphs";
import { InputScreen } from "./screens/InputScreen";
import { Media } from "./screens/Media";
import { SafeArea } from "./screens/SafeArea";
import { Scrolling } from "./screens/Scrolling";
import { colors } from "./theme";

const SCREENS: { id: string; title: string; detail: string; Screen: ComponentType }[] = [
  { id: "scrolling", title: "Scrolling", detail: "Metal frames, fling, scroll-blit", Screen: Scrolling },
  { id: "input", title: "Native input", detail: "Typing, chips, the + menu, multiline growth", Screen: InputScreen },
  { id: "controls", title: "Menus and toolbar", detail: "UIMenu over pixel controls, a glass toolbar", Screen: Controls },
  { id: "media", title: "Web and video", detail: "Native views in the layout, under a sheet", Screen: Media },
  { id: "glyphs", title: "Text and emoji", detail: "CoreText fallback for every script and colour emoji", Screen: Glyphs },
  { id: "crashes", title: "Crash reports", detail: "Native crashes and Rust panics, kept for the next launch", Screen: Crashes },
  { id: "safe-area", title: "Safe areas", detail: "Full bleed with the insets the host reports", Screen: SafeArea },
];

export function App({ root }: { root: DeviceRoot }) {
  return (
    <MetricsContext.Provider value={{ root, pt: root.displayScale }}>
      <Navigator />
    </MetricsContext.Provider>
  );
}

function Navigator() {
  const { pt } = useMetrics();
  const insets = useSafeArea();
  const [open, setOpen] = useState<string | null>(null);
  const screen = SCREENS.find((entry) => entry.id === open);
  if (screen?.id === "safe-area") {
    return (
      <Box style={{ width: "100%", height: "100%" }}>
        <SafeArea />
        <BackOverlay onBack={() => setOpen(null)} />
      </Box>
    );
  }
  return (
    <Box style={{ width: "100%", height: "100%", flexDirection: "column", background: colors.background }}>
      <Box style={{ height: 56 * pt + insets.top, padding: { top: insets.top, left: 16 * pt + insets.left, right: 16 * pt + insets.right }, flexDirection: "row", alignItems: "center", gap: 12 * pt, flexShrink: 0 }}>
        {screen ? (
          <Box onClick={() => setOpen(null)} style={{ height: 36 * pt, padding: { left: 12 * pt, right: 14 * pt }, cornerRadius: 18 * pt, background: colors.raised, flexDirection: "row", alignItems: "center" }}>
            <Text style={{ color: colors.text, fontSize: 16 * pt }}>‹ Back</Text>
          </Box>
        ) : null}
        <Text style={{ color: colors.text, fontSize: 22 * pt, fontWeight: 600 }}>{screen?.title ?? "pixel on iOS"}</Text>
      </Box>
      <Box style={{ flexGrow: 1, flexBasis: 0, flexDirection: "column" }}>{screen ? <screen.Screen /> : <Home onOpen={setOpen} />}</Box>
    </Box>
  );
}

function Home({ onOpen }: { onOpen(id: string): void }) {
  const { pt } = useMetrics();
  return (
    <Box style={{ flexDirection: "column", gap: 10 * pt, padding: { left: 16 * pt, right: 16 * pt } }}>
      {SCREENS.map(({ id, title, detail }) => (
        <Box key={id} onClick={() => onOpen(id)} style={{ flexDirection: "column", gap: 4 * pt, padding: 16 * pt, cornerRadius: 16 * pt, background: colors.surface }}>
          <Text style={{ color: colors.text, fontSize: 18 * pt }}>{title}</Text>
          <Text style={{ color: colors.muted, fontSize: 14 * pt }}>{detail}</Text>
        </Box>
      ))}
    </Box>
  );
}

function BackOverlay({ onBack }: { onBack(): void }) {
  const { pt } = useMetrics();
  const insets = useSafeArea();
  return (
    <Box onClick={onBack} style={{ position: "absolute", inset: { left: 16 * pt + insets.left, top: insets.top + 10 * pt }, height: 36 * pt, padding: { left: 12 * pt, right: 14 * pt }, cornerRadius: 18 * pt, background: [255, 255, 255, 40], flexDirection: "row", alignItems: "center" }}>
      <Text style={{ color: colors.text, fontSize: 16 * pt }}>‹ Back</Text>
    </Box>
  );
}
