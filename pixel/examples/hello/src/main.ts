import { createRoot } from "@zenbu-labs/pixel";

const url = process.argv[2] ?? "https://github.com/zenbu-labs";
const partition = process.argv[3] ?? process.env.HELLO_PARTITION;

const root = createRoot({
  onKey(event) {
    if (event.kind === "press" && event.mods.ctrl && event.key === "c") {
      root.stop();
      return true;
    }
  },
});

const page = root.loadURL(url, partition ? { partition } : undefined);
page.onChange((state) => root.setTitle(state.title || state.url));
