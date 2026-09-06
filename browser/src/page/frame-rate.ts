import { screen } from "electron";

// A herdr pane redraws each frame by deleting the old image before sending the
// new one, so every frame is a blank followed by a picture. That flickers at
// any rate, and it is herdr's to fix (zenbu-labs/terminal-browser#97, item 5),
// but matching a 144 Hz monitor means doing it 144 times a second: one mouse
// move across one cell costs about seventy full-surface images through a pty.
// Thirty is the rate this was measured at without anyone finding it slow.
// Delete this when a herdr frame replaces rather than clears.
const HERDR_FRAME_RATE = 30;

function inHerdrPane() {
  return Boolean(process.env.HERDR_PANE_ID && process.env.HERDR_SOCKET_PATH);
}

export function frameRate() {
  const configured = Number(process.env.TERMINAL_BROWSER_FPS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(1, Math.min(240, Math.round(configured)));
  }
  if (inHerdrPane()) {
    return HERDR_FRAME_RATE;
  }
  const fastest = Math.max(
    0,
    ...screen.getAllDisplays().map((display) => display.displayFrequency),
  );
  return fastest > 0 ? Math.min(240, Math.round(fastest)) : 60;
}
