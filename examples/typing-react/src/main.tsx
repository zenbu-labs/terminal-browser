import { createRoot } from "pixel-react";

import { App } from "./app";

const root = createRoot({
  onKey(event) {
    if (event.mods.ctrl && (event.key === "q" || event.key === "c")) {
      root.stop();
      process.exit(0);
    }
  },
  onResize() {
    render();
  },
});

function render() {
  // Fresh object so a resize (or font zoom, which changes basePx) re-renders
  // with the new metrics.
  root.render(<App info={{ ...root.info }} />);
}

render();
