import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { app, screen } from "electron";

import { runDaemon } from "./daemon";
import { ConfigStore, LOGS_DIR, SETTINGS_FILE, SHORTCUTS_FILE, ensureDataDir, installedVersion } from "shared";
import { Telemetry } from "./telemetry";
import type { CrashSource } from "./telemetry";
import { appLog } from "@zenbu-labs/pixel";
import { claimProfile } from "./profile";
import { registerScheme } from "./pages/scheme";
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
// offscreen rendering never delivers mouse input to cross-process iframes, so keep them in-process
app.commandLine.appendSwitch("disable-site-isolation-trials");

if (process.env.TERMINAL_BROWSER_DISABLE_GPU === "1") {
  app.commandLine.appendSwitch("disable-gpu");
}
try {
  ensureDataDir();
  fs.mkdirSync(LOGS_DIR, { recursive: true });
} catch {}
app.commandLine.appendSwitch("enable-logging", "file");
app.commandLine.appendSwitch("log-file", path.join(LOGS_DIR, "chromium.log"));
app.setName("terminal-browser");
claimProfile();
registerScheme();

const CRASH_REPORT_EXIT_DEADLINE_MS = 2000;
const crashReports = new Telemetry({
  version: installedVersion() ?? "dev",
  usageEnabled: () => false,
  crashReportsEnabled: () =>
    new ConfigStore({ settings: SETTINGS_FILE, shortcuts: SHORTCUTS_FILE }).load().settings?.["telemetry.crashReports"] !== "off",
  terminal: () => null,
});
function reportAndExit(error: unknown, source: CrashSource) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  const exit = () => app.exit(1);
  const deadline = setTimeout(exit, CRASH_REPORT_EXIT_DEADLINE_MS);
  void crashReports.crashed(error, source).finally(() => {
    clearTimeout(deadline);
    exit();
  });
}
process.on("uncaughtException", (error) => reportAndExit(error, "uncaughtException"));
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`${reason instanceof Error ? reason.stack : String(reason)}\n`);
  void crashReports.crashed(reason, "unhandledRejection");
});


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
})().catch((error) => reportAndExit(error, "startup"));
