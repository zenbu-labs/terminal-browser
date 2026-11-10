import { screen } from "electron";

let requested = 0;
const listeners = new Set<() => void>();

function clamp(fps: number) {
  return Math.max(1, Math.min(240, Math.round(fps)));
}

export function requestFrameRate(fps: number) {
  const next = Number.isFinite(fps) && fps > 0 ? clamp(fps) : 0;
  if (next === requested) return;
  requested = next;
  for (const listener of listeners) listener();
}

export function onFrameRateChange(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function frameRate() {
  const configured = Number(process.env.PIXEL_FPS);
  if (Number.isFinite(configured) && configured > 0) {
    return clamp(configured);
  }
  if (requested > 0) {
    return requested;
  }
  const fastest = Math.max(
    0,
    ...screen.getAllDisplays().map((display) => display.displayFrequency),
  );
  return fastest > 0 ? Math.min(240, Math.round(fastest)) : 60;
}
