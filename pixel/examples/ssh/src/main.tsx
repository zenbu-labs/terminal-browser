import { Box, createRoot, Text, WebView } from "@zenbu-labs/pixel";

const args = process.argv.slice(2);
const proxy = args.find((arg) => arg.startsWith("--proxy="))?.slice("--proxy=".length);
const partition = args.find((arg) => arg.startsWith("--partition="))?.slice("--partition=".length);
const url = args.find((arg) => !arg.startsWith("--")) ?? "https://example.com";

const root = createRoot({
  onKey(event) {
    if (event.kind === "press" && event.mods.ctrl && event.key === "c") {
      root.stop();
      return true;
    }
  },
});

root.render(
  <Box style={{ width: "100%", height: "100%", flexDirection: "column" }}>
    <Box style={{ height: 24, alignItems: "center", padding: { left: 8 }, gap: 12 }}>
      <Text>{proxy ? `via ${proxy}` : "direct"}</Text>
      <Text>{url}</Text>
    </Box>
    <WebView
      src={url}
      proxy={proxy}
      partition={partition}
      style={{ flexGrow: 1 }}
      onChange={(state) => root.setTitle(state.title || state.url)}
    />
  </Box>,
);
