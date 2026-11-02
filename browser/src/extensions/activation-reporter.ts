import { ipcRenderer } from "electron";

export const ACTIVATION_CHANNEL = "tb-ext:user-activation";
const REPORT_EVERY_MS = 200;

// HTML's activation-triggering input events, the ones Chrome gives a frame its
// transient user activation for.
function activates(event: Event): boolean {
  if (!event.isTrusted) return false;
  if (event.type === "keydown") return (event as KeyboardEvent).key !== "Escape";
  if (event.type === "pointerdown") return (event as PointerEvent).pointerType === "mouse";
  if (event.type === "pointerup") return (event as PointerEvent).pointerType !== "mouse";
  return true;
}

// Tells the browser this frame got a click or key press, so a user gesture
// counts for the frame the user actually used and not its whole tab.
export function reportUserActivation() {
  let last = 0;
  const report = (event: Event) => {
    if (!activates(event)) return;
    const now = Date.now();
    if (now - last < REPORT_EVERY_MS) return;
    last = now;
    ipcRenderer.send(ACTIVATION_CHANNEL);
  };
  for (const type of ["keydown", "mousedown", "pointerdown", "pointerup", "touchend"]) {
    globalThis.addEventListener?.(type, report, { capture: true });
  }
}
