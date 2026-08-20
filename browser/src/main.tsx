import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { app, screen } from "electron";

import { runDaemon } from "./daemon";
import { LOGS_DIR, ensureDataDir } from "pixel-store";
import { appLog } from "pixel-react";
import { claimProfile } from "./profile";
import { importProfileCookies, removeProfilePartition } from "./profile-import";
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

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
const primaryProfile = claimProfile();


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
  const partitionRemoval = flagValue(process.argv, "--remove-partition");
  if (partitionRemoval) {
    if (!primaryProfile) throw new Error("stop the terminal-browser daemon before removing a profile");
    process.stdout.write(`${JSON.stringify({ removed: removeProfilePartition(partitionRemoval) })}\n`);
    app.quit();
    return;
  }
  const cookieImport = flagValue(process.argv, "--import-cookies");
  if (cookieImport) {
    if (!primaryProfile) throw new Error("stop the terminal-browser daemon before importing a profile");
    const partition = flagValue(process.argv, "--partition");
    if (!partition) throw new Error("profile import requires a partition");
    const result = await importProfileCookies(
      cookieImport,
      partition,
      process.argv.includes("--replace-cookies"),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    app.quit();
    return;
  }
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

function flagValue(argv: string[], name: string): string | null {
  return argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
}
