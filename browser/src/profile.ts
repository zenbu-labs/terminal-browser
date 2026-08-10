import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { app } from "electron";
import { APP_DIR_NAME } from "pixel-store";

// er i don't think this is necessary anymore given our daemon but i guess it doesn't hurt to be explicit 
export function claimProfile() {
  const appData = process.env.TERMINAL_BROWSER_APPDATA ?? app.getPath("appData");
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
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "terminal-browser-")));
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
