import { app, webContents as allWebContents } from "electron";
import type { WebContents } from "electron";

import { EXTERNAL_LAUNCH_INPUT, permitExternalLaunch } from "./external-protocol";

let watching = false;

function watch(contents: WebContents) {
  contents.on("input-event", (_event, input) => {
    if (EXTERNAL_LAUNCH_INPUT.has(input.type)) permitExternalLaunch();
  });
}

export function watchExternalLaunchInput() {
  if (watching) return;
  watching = true;
  for (const contents of allWebContents.getAllWebContents()) watch(contents);
  app.on("web-contents-created", (_event, contents) => watch(contents));
}
