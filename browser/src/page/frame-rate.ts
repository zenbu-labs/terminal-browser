import { screen } from "electron";


export function frameRate() {
  const configured = Number(process.env.TERMINAL_BROWSER_FPS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(1, Math.min(240, Math.round(configured)));
  }
  const fastest = Math.max(
    0,
    ...screen.getAllDisplays().map((display) => display.displayFrequency),
  );
  return fastest > 0 ? Math.min(240, Math.round(fastest)) : 60;
}
