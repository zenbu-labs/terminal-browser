import React from "react";
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

function Boot() {
  return <App width={root.info.width} />;
}

function render() {
  root.render(<Boot />);
}

render();
