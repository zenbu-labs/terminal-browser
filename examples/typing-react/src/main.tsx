import { createRoot } from "pixel-react";

import { App } from "./app";

const root = createRoot({
  onKey(event) {
    if (event.mods.ctrl && (event.key === "q" || event.key === "c")) {
      root.stop();
      process.exit(0);
    }
  },
});

root.render(<App info={root.info} />);
