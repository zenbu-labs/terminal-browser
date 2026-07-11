import { createRoot } from "pixel-react";

import { App } from "./app";
import { store } from "./session";

const root = createRoot({
  onKey(event) {
    if (event.mods.ctrl && event.key === "q") {
      root.stop();
      process.exit(0);
    }
    if (event.mods.super && event.key === "b") {
      store.toggleSidebar();
      return;
    }
    const session = store.active();
    if (session.ask) {
      if (event.key === "enter" || event.key === "y") session.ask.resolve(true);
      if (event.key === "escape" || event.key === "n") session.ask.resolve(false);
      return;
    }
    if (event.key === "escape") session.interrupt();
    if (event.mods.ctrl && event.key === "o") session.cycleModel();
    if (event.mods.ctrl && event.key === "p") session.cycleMode();
    if (event.mods.ctrl && event.key === "t") session.cycleThinking();
  },
});

root.render(<App info={root.info} />);
