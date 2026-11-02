import { createRoot } from "@zenbu-labs/pixel-ios";

import { App } from "./App";

export function start() {
  const root = createRoot();
  root.render(<App root={root} />);
}
