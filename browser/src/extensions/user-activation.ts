import { app, webContents as allWebContents } from "electron";
import type { WebContents, WebFrameMain } from "electron";
import { frameDocumentId, frameDocumentLifecycle } from "./native";

// Chrome's transient user activation lasts five seconds.
export const USER_ACTIVATION_MS = 5_000;
const ACTIVATING_INPUT = new Set(["mouseDown", "mouseUp", "rawKeyDown", "keyDown", "touchEnd", "gestureTap"]);

// The input that gives a document activation in Chromium (mouseup and keyup don't).
const ACTIVATION_START = new Set(["mouseDown", "rawKeyDown", "keyDown", "touchEnd", "gestureTap"]);

// One activating input: when it came, which documents the page showed then, and whether a window used it up.
interface PageActivation {
  at: number;
  documents: Set<string>;
  used: boolean;
}

const lastInput = new WeakMap<WebContents, number>();
const lastActivation = new WeakMap<WebContents, PageActivation>();
const watched = new WeakSet<WebContents>();
let listening = false;

function documentIds(contents: WebContents): Set<string> {
  try {
    return new Set(contents.mainFrame.framesInSubtree.filter((frame) => !frame.isDestroyed()).map(frameDocumentId));
  } catch {
    return new Set();
  }
}

export function watchInput(contents: WebContents) {
  if (watched.has(contents)) return;
  watched.add(contents);
  contents.on("input-event", (_event, input) => {
    if (ACTIVATING_INPUT.has(input.type)) lastInput.set(contents, Date.now());
    if (ACTIVATION_START.has(input.type)) lastActivation.set(contents, { at: Date.now(), documents: documentIds(contents), used: false });
  });
}

// Chromium's popup rule for a window.open it has already run, by which point it has used up the frame's own
// activation, so this keeps a copy: the input is recent, came while every frame that may have opened the window
// showed the document it shows now, and opens one window only.
export function takePopupActivation(contents: WebContents, openers: WebFrameMain[]): boolean {
  const activation = lastActivation.get(contents);
  if (!activation || activation.used || Date.now() - activation.at > USER_ACTIVATION_MS) return false;
  if (openers.length === 0 || !openers.every((frame) => activation.documents.has(frameDocumentId(frame)))) return false;
  activation.used = true;
  return true;
}

// Whether the user clicked or typed anywhere in this page in the last five
// seconds (Chromium's WebContents::HasRecentInteraction).
export function hadRecentInput(contents: WebContents): boolean {
  return Date.now() - (lastInput.get(contents) ?? 0) <= USER_ACTIVATION_MS;
}

// Chromium's RenderFrameHost::HasTransientUserActivation, which pixel's Electron patches expose on WebFrameMain:
// the user clicked or typed in this frame (or a frame inside it) within the last five seconds.
// A document being unloaded or kept in the back/forward cache reads the activation of whatever replaced it.
export function hasTransientUserActivation(frame: WebFrameMain): boolean {
  if (frame.isDestroyed() || frame.detached || frameDocumentLifecycle(frame) !== "active") return false;
  return (frame as unknown as { hasTransientUserActivation(): boolean }).hasTransientUserActivation();
}

const ACTIVATION_SETTLE_MS = [0, 10, 30, 100, 300, 1000];

// Resolves true once the user clicks or types in the page `contents` shows now (Chromium's own per-frame activation,
// which lands a moment after the input), or false if that page goes away first.
export function nextUserActivation(contents: WebContents): Promise<boolean> {
  const frame = contents.mainFrame;
  const documentId = frameDocumentId(frame);
  const activated = () => frameDocumentId(contents.mainFrame) === documentId && hasTransientUserActivation(frame);
  if (activated()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const finish = (result: boolean) => {
      for (const timer of timers) clearTimeout(timer);
      contents.off("input-event", onInput);
      contents.off("did-navigate", onNavigate);
      contents.off("destroyed", onDestroyed);
      resolve(result);
    };
    const onInput = (_event: unknown, input: { type: string }) => {
      if (!ACTIVATING_INPUT.has(input.type)) return;
      for (const delay of ACTIVATION_SETTLE_MS) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (activated()) finish(true);
        }, delay);
        timers.add(timer);
      }
    };
    const onNavigate = () => {
      if (frameDocumentId(contents.mainFrame) !== documentId) finish(false);
    };
    const onDestroyed = () => finish(false);
    contents.on("input-event", onInput);
    contents.on("did-navigate", onNavigate);
    contents.once("destroyed", onDestroyed);
  });
}

export function listenForUserActivation() {
  if (listening) return;
  listening = true;
  for (const contents of allWebContents.getAllWebContents()) watchInput(contents);
  app.on("web-contents-created", (_event, contents) => watchInput(contents));
}
