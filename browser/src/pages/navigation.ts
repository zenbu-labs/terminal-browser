import { app } from "electron";
import type { WebContents } from "electron";

import { isInternalUrl } from "./internal";

function blockWebNavigation(contents: WebContents) {
  contents.on("will-frame-navigate", (event) => {
    if (!isInternalUrl(event.url)) return;
    const initiator = event.initiator?.origin ?? "";
    if (event.isMainFrame && isInternalUrl(initiator)) return;
    event.preventDefault();
  });
}

export function guardInternalNavigation() {
  app.on("web-contents-created", (_event, contents) => blockWebNavigation(contents));
}
