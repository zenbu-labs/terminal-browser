import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { app } from "electron";
import { APP_DIR_NAME } from "pixel-store";

// the daemon keeps the base profile dir across restarts so --partition storage
// never moves; the lock claim prevents two daemons sharing a dir
const DAEMON_LOCK_WAIT_MS = 5_000;

export async function claimProfile(): Promise<void> {
  const appData = process.env.TERMINAL_BROWSER_APPDATA ?? app.getPath("appData");
  await waitForFreeLock(path.join(appData, APP_DIR_NAME, "terminal-browser.lock"));
  for (let i = 0; i < 32; i++) {
    const dir = path.join(appData, i === 0 ? APP_DIR_NAME : `${APP_DIR_NAME}-${i + 1}`);
    const lock = path.join(dir, "terminal-browser.lock");
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
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), APP_DIR_NAME)));
}

// a previous daemon may still be releasing the dir when we start; if it frees
// up soon we keep the base dir instead of drifting to a numbered one
async function waitForFreeLock(lock: string): Promise<void> {
  const deadline = Date.now() + DAEMON_LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    let holder: number;
    try {
      holder = Number(fs.readFileSync(lock, "utf8"));
    } catch {
      return;
    }
    if (!holder || !alive(holder)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
