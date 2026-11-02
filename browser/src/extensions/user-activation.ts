import { app, ipcMain, webContents as allWebContents } from "electron";
import type { WebContents, WebFrameMain } from "electron";

import { ACTIVATION_CHANNEL } from "./activation-reporter";

// Chrome's transient user activation lasts five seconds.
export const USER_ACTIVATION_MS = 5_000;
// How long after real input reaches a page its frame may still report it.
const REPORT_WINDOW_MS = 1_000;
const ACTIVATING_INPUT = new Set(["mouseDown", "mouseUp", "rawKeyDown", "keyDown", "touchEnd", "gestureTap"]);

const lastInput = new WeakMap<WebContents, number>();
const watched = new WeakSet<WebContents>();
const activations = new Map<string, number>();
let listening = false;

function frameKey(frame: WebFrameMain): string {
  return `${frame.processId}:${frame.frameToken}`;
}

function watchInput(contents: WebContents) {
  if (watched.has(contents)) return;
  watched.add(contents);
  contents.on("input-event", (_event, input) => {
    if (ACTIVATING_INPUT.has(input.type)) lastInput.set(contents, Date.now());
  });
}

function hadInputWithin(contents: WebContents, ms: number): boolean {
  return Date.now() - (lastInput.get(contents) ?? 0) <= ms;
}

// Whether the user clicked or typed anywhere in this page in the last five
// seconds (Chromium's WebContents::HasRecentInteraction).
export function hadRecentInput(contents: WebContents): boolean {
  return hadInputWithin(contents, USER_ACTIVATION_MS);
}

// Like Chrome, activating a frame also activates the frames that contain it,
// but never the frames inside it.
function noteActivation(frame: WebFrameMain) {
  const now = Date.now();
  for (const [key, at] of activations) if (now - at > USER_ACTIVATION_MS) activations.delete(key);
  for (let current: WebFrameMain | null = frame; current; current = current.parent) activations.set(frameKey(current), now);
}

// A frame reports a click or key press it received; the browser only believes
// it when real input reached the page just before.
export function frameReportedActivation(contents: WebContents, frame: WebFrameMain | null) {
  if (frame && !frame.isDestroyed() && hadInputWithin(contents, REPORT_WINDOW_MS)) noteActivation(frame);
}

// Chrome's RenderFrameHost::HasTransientUserActivation: the user clicked or
// typed in this frame (or a frame inside it) within the last five seconds.
export function hasTransientUserActivation(frame: WebFrameMain): boolean {
  const at = activations.get(frameKey(frame));
  return at !== undefined && Date.now() - at <= USER_ACTIVATION_MS;
}

export function listenForUserActivation() {
  if (listening) return;
  listening = true;
  ipcMain.on(ACTIVATION_CHANNEL, (event) => frameReportedActivation(event.sender, event.senderFrame));
  for (const contents of allWebContents.getAllWebContents()) watchInput(contents);
  app.on("web-contents-created", (_event, contents) => watchInput(contents));
}
