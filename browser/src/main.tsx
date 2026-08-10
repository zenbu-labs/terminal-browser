import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { app, screen } from "electron";

import { runDaemon } from "./daemon";
import { LOGS_DIR, ensureDataDir } from "pixel-store";
import { appLog, displayScale } from "pixel-react";
import { claimProfile } from "./profile";
import { RENDER_ZOOM } from "./page/render-zoom";

app.commandLine.appendSwitch("disable-renderer-backgrounding");
// Part of the render-zoom workaround (see page/render-zoom.ts): the zoom path
// needs the process-wide scale forced before Electron is ready. The native
// scale path passes the scale per window instead and must not force it.
if (RENDER_ZOOM && !process.env.TERMINAL_BROWSER_DISPLAY_SCALE) {
  const scale = displayScale();
  appLog(
    "info",
    "scale",
    `compositor reports ${scale ?? "nothing"} (WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY ?? "unset"})`,
  );
  if (scale != null && scale > 1) {
    app.commandLine.appendSwitch("force-device-scale-factor", String(scale));
    appLog("info", "scale", `forcing device scale factor ${scale}`);
  }
}
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
try {
  ensureDataDir();
  fs.mkdirSync(LOGS_DIR, { recursive: true });
} catch {}
app.commandLine.appendSwitch("enable-logging", "file");
app.commandLine.appendSwitch("log-file", path.join(LOGS_DIR, "chromium.log"));
app.setName("terminal-browser");
claimProfile();


function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("no port assigned"));
      });
    });
  });
}


void (async () => {
  const cdpPort = await freePort().catch(() => null);
  if (cdpPort != null) app.commandLine.appendSwitch("remote-debugging-port", String(cdpPort));
  await app.whenReady();
  appLog(
    "info",
    "scale",
    `chromium reports ${screen
      .getAllDisplays()
      .map((d) => `${d.size.width}x${d.size.height}@${d.scaleFactor}x`)
      .join(", ")}`,
  );
  await runDaemon(cdpPort);
})().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  app.exit(1);
});
