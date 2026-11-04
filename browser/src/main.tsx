import path from "node:path";

import { app, screen } from "electron";

import { runDaemon } from "./daemon";
import { openDebuggingPipe } from "./cdp/server";
import { ConfigStore, DAEMON_PORT_SWITCH, LOGS_DIR, SETTINGS_FILE, SHORTCUTS_FILE, ensurePrivateFile, ensurePrivateState, installedVersion } from "shared";
import { Telemetry } from "./telemetry";
import type { CrashSource } from "./telemetry";
import { appLog } from "@zenbu-labs/pixel";
import { claimProfile } from "./profile";
import { registerScheme } from "./pages/scheme";
// Node starts a debugger listening on a TCP port when it gets SIGUSR1, unless something handles the signal.
process.on("SIGUSR1", () => {});
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("enable-features", "WebMCP");
app.commandLine.appendSwitch("disable-features", "FedCm");

if (process.env.TERMINAL_BROWSER_DISABLE_GPU === "1") {
  app.commandLine.appendSwitch("disable-gpu");
}
function startOrExit(start: () => void) {
  try {
    start();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

const CHROMIUM_LOG = path.join(LOGS_DIR, "chromium.log");
startOrExit(() => {
  ensurePrivateState();
  ensurePrivateFile(CHROMIUM_LOG);
});
app.commandLine.appendSwitch("enable-logging", "file");
app.commandLine.appendSwitch("log-file", CHROMIUM_LOG);
app.setName("terminal-browser");
startOrExit(claimProfile);
registerScheme();

const CRASH_REPORT_EXIT_DEADLINE_MS = 2000;
const crashReports = new Telemetry({
  version: installedVersion() ?? "dev",
  usageEnabled: () => false,
  crashReportsEnabled: () =>
    new ConfigStore({ settings: SETTINGS_FILE, shortcuts: SHORTCUTS_FILE }).load().settings?.["telemetry.crashReports"] !== "off",
  terminal: () => null,
});
let debuggingPipe: ReturnType<typeof openDebuggingPipe> | null = null;

function reportAndExit(error: unknown, source: CrashSource) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  const exit = () => {
    debuggingPipe?.destroy();
    app.exit(1);
  };
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


void (async () => {
  debuggingPipe = app.commandLine.hasSwitch("remote-debugging-pipe") ? openDebuggingPipe() : null;
  await app.whenReady();
  appLog(
    "info",
    "scale",
    `chromium reports ${screen
      .getAllDisplays()
      .map((d) => `${d.size.width}x${d.size.height}@${d.scaleFactor}x`)
      .join(", ")}`,
  );
  const port = app.commandLine.getSwitchValue(DAEMON_PORT_SWITCH);
  await runDaemon(debuggingPipe, port === "" ? null : Number(port));
})().catch((error) => reportAndExit(error, "startup"));
