import { Box, Text, Video, WebView } from "@zenbu-labs/pixel/device";
import { useState } from "react";

import { useMetrics } from "../metrics";
import { colors } from "../theme";
import { Button, Section } from "../ui";

const PAGE = `data:text/html,${encodeURIComponent(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="margin:0;font:17px -apple-system;background:linear-gradient(160deg,#ff7a59,#7b5cff);color:white;padding:18px"><h2 style="margin:0 0 8px">A real WKWebView</h2><p>Laid out by pixel like any Box, clipped by the scroll view, and covered by pixel's sheet.</p><button onclick="this.textContent='Tapped '+(++window.n||(window.n=1))+'x'" style="font-size:17px;padding:10px 16px;border-radius:12px;border:0">Tap me</button>${"<p>Scroll inside the page once it is focused.</p>".repeat(12)}</body>`)}`;
const VIDEO = "https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8";

export function Media() {
  const { pt } = useMetrics();
  const [sheet, setSheet] = useState(false);
  const [paused, setPaused] = useState(false);
  const [time, setTime] = useState(0);
  return (
    <Box style={{ flexGrow: 1, flexBasis: 0, flexDirection: "column" }}>
      <Box style={{ flexGrow: 1, flexBasis: 0, overflow: "scroll", flexDirection: "column", padding: { left: 16 * pt, right: 16 * pt, bottom: 160 * pt } }}>
        <Section title="Web view">
          <WebView src={PAGE} style={{ height: 300 * pt, cornerRadius: 16 * pt }} />
        </Section>
        <Section title={`Video · ${(time / 1000).toFixed(1)} s`}>
          <Video src={VIDEO} paused={paused} muted loop onTime={(ms) => setTime(ms)} style={{ height: 210 * pt, background: [0, 0, 0, 255] }} />
          <Box style={{ flexDirection: "row", gap: 10 * pt }}>
            <Button label={paused ? "Play" : "Pause"} onPress={() => setPaused(!paused)} />
            <Button label="Show sheet" onPress={() => setSheet(true)} />
          </Box>
        </Section>
        {Array.from({ length: 12 }, (_, i) => (
          <Text key={i} style={{ color: colors.muted, fontSize: 15 * pt, margin: { top: 14 * pt } }}>
            {`Filler paragraph ${i + 1}: scroll the native views under the top edge to see them clip.`}
          </Text>
        ))}
      </Box>
      {sheet ? (
        <Box onClick={() => setSheet(false)} style={{ position: "absolute", inset: { left: 0, right: 0, top: 0, bottom: 0 }, background: [0, 0, 0, 120] }}>
          <Box
            onClick={() => {}}
            style={{ position: "absolute", inset: { left: 0, right: 0, top: 440 * pt, bottom: 0 }, cornerRadius: 24 * pt, background: colors.surface, padding: 24 * pt, flexDirection: "column", gap: 14 * pt }}
          >
            <Text style={{ color: colors.text, fontSize: 20 * pt }}>A pixel sheet</Text>
            <Text style={{ color: colors.muted, fontSize: 15 * pt }}>Drawn by the engine over the web view and the video. The native views are masked where it covers them, and stop playing when hidden.</Text>
            <Button label="Close" onPress={() => setSheet(false)} />
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
