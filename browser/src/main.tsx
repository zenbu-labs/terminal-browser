import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { app } from "electron";

import { runDaemon } from "./daemon";
import { LOGS_DIR, ensureDataDir } from "pixel-store";
import { claimProfile } from "./profile";
import { createSession } from "./session/session";
import type { SessionHandle } from "./session/session";

app.commandLine.appendSwitch("disable-renderer-backgrounding");
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

let session: SessionHandle | null = null;

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

process.on("SIGINT", () => (session ? session.close() : app.exit(130)));
process.on("SIGTERM", () => (session ? session.close() : app.exit(143)));

void (async () => {
  const cdpPort = await freePort().catch(() => null);
  if (cdpPort != null) app.commandLine.appendSwitch("remote-debugging-port", String(cdpPort));
  await app.whenReady();
  if (process.argv.slice(2).includes("--daemon")) {
    await runDaemon(cdpPort);
    return;
  }
  const argv = process.argv.slice(2);
  session = createSession({
    key: String(process.pid),
    argv,
    env: process.env,
    cwd: argv.find((arg) => arg.startsWith("--cwd="))?.slice("--cwd=".length) ?? process.cwd(),
    cdpPort,
    onClose: (code) => app.exit(code),
  });
})().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  app.exit(1);
});
