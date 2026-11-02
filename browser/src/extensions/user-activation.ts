import { app, webContents as allWebContents } from "electron";
import type { WebContents, WebFrameMain } from "electron";

// Chrome's transient user activation lasts five seconds.
export const USER_ACTIVATION_MS = 5_000;
const ACTIVATING_INPUT = new Set(["mouseDown", "mouseUp", "rawKeyDown", "keyDown", "touchEnd", "gestureTap"]);

const lastInput = new WeakMap<WebContents, number>();
const watched = new WeakSet<WebContents>();
let listening = false;

function watchInput(contents: WebContents) {
  if (watched.has(contents)) return;
  watched.add(contents);
  contents.on("input-event", (_event, input) => {
    if (ACTIVATING_INPUT.has(input.type)) lastInput.set(contents, Date.now());
  });
}

// Whether the user clicked or typed anywhere in this page in the last five
// seconds (Chromium's WebContents::HasRecentInteraction).
export function hadRecentInput(contents: WebContents): boolean {
  return Date.now() - (lastInput.get(contents) ?? 0) <= USER_ACTIVATION_MS;
}

// Resolves on the next click or key press in `contents`, or false if it closes first.
export function nextUserInput(contents: WebContents): Promise<boolean> {
  watchInput(contents);
  if (hadRecentInput(contents)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onInput = (_event: unknown, input: { type: string }) => {
      if (!ACTIVATING_INPUT.has(input.type)) return;
      contents.off("input-event", onInput);
      contents.off("destroyed", onDestroyed);
      resolve(true);
    };
    const onDestroyed = () => {
      contents.off("input-event", onInput);
      resolve(false);
    };
    contents.on("input-event", onInput);
    contents.once("destroyed", onDestroyed);
  });
}

// Chromium's RenderFrameHost::HasTransientUserActivation, which pixel's Electron patches expose on WebFrameMain:
// the user clicked or typed in this frame (or a frame inside it) within the last five seconds.
export function hasTransientUserActivation(frame: WebFrameMain): boolean {
  if (frame.isDestroyed()) return false;
  return (frame as unknown as { hasTransientUserActivation(): boolean }).hasTransientUserActivation();
}

export function listenForUserActivation() {
  if (listening) return;
  listening = true;
  for (const contents of allWebContents.getAllWebContents()) watchInput(contents);
  app.on("web-contents-created", (_event, contents) => watchInput(contents));
}
