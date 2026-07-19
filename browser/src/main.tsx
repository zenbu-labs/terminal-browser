import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { app } from "electron";

import { runDaemon } from "./daemon";
import { createSession } from "./session";
import type { SessionHandle } from "./session";

app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
const LOG_DIR = path.join(os.homedir(), ".pixel-browser", "logs");
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch {}
app.commandLine.appendSwitch("enable-logging", "file");
app.commandLine.appendSwitch("log-file", path.join(LOG_DIR, "chromium.log"));
app.setName("Pixel Browser");
claimProfile();

/** Chromium profiles are single-process: concurrent instances sharing one
 * userData dir corrupt and deadlock the LevelDB stores (IndexedDB, Local
 * Storage — youtube's icons hang on a wedged IndexedDB, for example). Each
 * instance claims the first profile dir whose lock holder is gone; the first
 * instance keeps the original dir so logins survive. */
function claimProfile() {
  const appData = process.env.PIXEL_BROWSER_APPDATA ?? app.getPath("appData");
  for (let i = 0; i < 32; i++) {
    const dir = path.join(appData, i === 0 ? "Pixel Browser" : `Pixel Browser ${i + 1}`);
    const lock = path.join(dir, "pixel.lock");
    try {
      fs.mkdirSync(dir, { recursive: true });
      try {
        fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
      } catch {
        const holder = Number(fs.readFileSync(lock, "utf8"));
        if (holder && holder !== process.pid && alive(holder)) continue;
        fs.writeFileSync(lock, String(process.pid));
      }
      app.setPath("userData", dir);
      app.on("will-quit", () => {
        try {
          if (Number(fs.readFileSync(lock, "utf8")) === process.pid) fs.unlinkSync(lock);
        } catch {}
      });
      return;
    } catch {}
  }
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "pixel-browser-")));
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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
  session = createSession({
    key: String(process.pid),
    argv: process.argv.slice(2),
    env: process.env,
    cdpPort,
    onClose: (code) => app.exit(code),
  });
})().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  app.exit(1);
});
