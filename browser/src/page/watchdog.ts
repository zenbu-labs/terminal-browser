import type { WebContents } from "electron";
import { appLog } from "pixel-react";
import { offscreenMode } from "./offscreen";

/** Guards against two failures with the same symptom -- a shared-texture
 * window where nothing drawable ever arrives:
 *
 * 1. (Confirmed from Chromium source and field reports, e.g. NVIDIA
 *    proprietary drivers, electron#52618.) The capturer's copy into the
 *    mappable texture fails every frame, so failed frames are dropped and the
 *    only paint events are empty ones: no texture, zero-size image.
 * 2. (SPECULATIVE, never observed.) The capturer cannot allocate its first
 *    texture, stops itself, and Electron ignores the stop, so paint events
 *    cease entirely.
 *
 * Either way the window would stay blank forever; demoting to bitmap mode
 * recovers both. If this watchdog misfires, disable it with
 * TERMINAL_BROWSER_WATCHDOG=0 and report what happened; it always logs
 * before demoting.
 *
 * It is deliberately self-contained: it observes the window's own events and
 * touches nothing else, so deleting this file (plus its one call site) removes
 * the behavior entirely. */

const KICK_INTERVAL_MS = 2000;
const KICKS_BEFORE_VERDICT = 3;

export function armSilentStopWatchdog(
  contents: WebContents,
  onSilent: (reason: string) => void,
): void {
  if (process.platform !== "linux") return;
  if (process.env.TERMINAL_BROWSER_WATCHDOG === "0") return;
  if (offscreenMode() !== "shared-texture") return;

  let sawContent = false;
  let timer: NodeJS.Timeout | undefined;

  const disarm = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    contents.off("paint", onPaint);
  };
  const onPaint = (event: Electron.WebContentsPaintEventParams, _rect: unknown, image: Electron.NativeImage) => {
    // Empty paints (no texture, zero-size image) are the failure signature,
    // so they must not disarm the watchdog.
    if (!event.texture && image.getSize().width <= 0) return;
    sawContent = true;
    disarm();
  };
  contents.on("paint", onPaint);
  contents.once("destroyed", disarm);

  contents.once("did-finish-load", () => {
    if (sawContent) return;
    let kicks = 0;
    const kick = () => {
      if (sawContent || contents.isDestroyed()) return;
      kicks += 1;
      if (kicks > KICKS_BEFORE_VERDICT) {
        disarm();
        appLog("warn", "texture", `no drawable paints ${kicks * KICK_INTERVAL_MS}ms after load`);
        onSilent("page loaded but no drawable frame arrived; assuming texture capture is broken");
        return;
      }
      contents.invalidate();
      timer = setTimeout(kick, KICK_INTERVAL_MS);
    };
    timer = setTimeout(kick, KICK_INTERVAL_MS);
  });
}
