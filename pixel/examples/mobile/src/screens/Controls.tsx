import { Box, NativeMenu, Text, Toolbar } from "@zenbu-labs/pixel/device";
import type { MenuItem } from "@zenbu-labs/pixel/device";
import { useState } from "react";

import { useMetrics } from "../metrics";
import { colors } from "../theme";
import { Section } from "../ui";

const MODELS = ["Opus 5.5", "Sonnet 5.5", "Haiku 5.5"];

export function Controls() {
  const { pt } = useMetrics();
  const [model, setModel] = useState(MODELS[0]);
  const [thinking, setThinking] = useState(true);
  const [last, setLast] = useState("nothing yet");
  const items: MenuItem[] = [
    { id: "models", title: "Model", inline: true, children: MODELS.map((name) => ({ id: name, title: name, checked: name === model })) },
    { id: "thinking", title: "Extended thinking", subtitle: thinking ? "On" : "Off", symbol: "brain", checked: thinking },
    { id: "more", title: "More", symbol: "ellipsis.circle", children: [{ id: "copy", title: "Copy transcript", symbol: "doc.on.doc" }, { id: "share", title: "Share", symbol: "square.and.arrow.up" }] },
  ];
  const choose = (id: string) => {
    if (MODELS.includes(id)) setModel(id);
    else if (id === "thinking") setThinking(!thinking);
    setLast(`menu: ${id}`);
  };
  return (
    <Box style={{ flexGrow: 1, flexBasis: 0, flexDirection: "column", padding: { left: 16 * pt, right: 16 * pt } }}>
      <Section title="Native menu over pixel-drawn controls">
        <Box style={{ flexDirection: "row" }}>
        <NativeMenu items={items} onSelect={choose}>
          <Box style={{ flexDirection: "row", gap: 8 * pt, padding: { left: 16 * pt, right: 16 * pt, top: 10 * pt, bottom: 10 * pt }, cornerRadius: 20 * pt, background: colors.raised }}>
            <Text style={{ color: colors.text, fontSize: 16 * pt }}>{`${model}${thinking ? " · thinking" : ""}`}</Text>
            <Text style={{ color: colors.muted, fontSize: 16 * pt }}>▾</Text>
          </Box>
        </NativeMenu>
        </Box>
      </Section>
      <Section title="Last action">
        <Text style={{ color: colors.text, fontSize: 16 * pt }}>{last}</Text>
      </Section>
      <Toolbar
        items={[
          { id: "compose", label: "New", symbol: "square.and.pencil" },
          { id: "search", label: "Search", symbol: "magnifyingglass" },
          { id: "settings", label: "Settings", symbol: "gearshape" },
          { id: "sidebar", label: "Sidebar", symbol: "sidebar.left", roomy: true },
        ]}
        onPress={(id) => setLast(`toolbar: ${id}`)}
        style={{ position: "absolute", inset: { right: 20 * pt, bottom: 40 * pt } }}
      />
    </Box>
  );
}
