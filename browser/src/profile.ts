import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { app } from "electron";
import {
  APP_DIR_NAME,
  UnsafeDirectoryError,
  UnsafeFileError,
  createPrivateFile,
  reclaimPrivateDir,
  tightenOwnedDir,
  tightenPrivateFile,
  tightenPrivateFiles,
  writePrivateFile,
} from "shared";

const OWN_FILES = ["extension-settings.json"];
const OWN_FOLDERS = ["extension-content-settings", "extension-content-rules"];

function tightenProfile(dir: string) {
  for (const name of OWN_FILES) tightenPrivateFile(path.join(dir, name));
  for (const name of OWN_FOLDERS) {
    tightenOwnedDir(path.join(dir, name));
    tightenPrivateFiles(path.join(dir, name));
  }
}

// er i don't think this is necessary anymore given our daemon but i guess it doesn't hurt to be explicit 
export function claimProfile() {
  const appData = process.env.TERMINAL_BROWSER_APPDATA ?? app.getPath("appData");
  for (let i = 0; i < 32; i++) {
    const dir = path.join(appData, i === 0 ? APP_DIR_NAME : `${APP_DIR_NAME}-${i + 1}`);
    const lock = path.join(dir, "terminal-browser.lock");
    try {
      reclaimPrivateDir(dir);
      try {
        createPrivateFile(lock, String(process.pid));
      } catch {
        const holder = Number(fs.readFileSync(lock, "utf8"));
        if (holder && holder !== process.pid && alive(holder)) continue;
        writePrivateFile(lock, String(process.pid));
      }
      tightenProfile(dir);
      app.setPath("userData", dir);
      app.on("will-quit", () => {
        try {
          if (Number(fs.readFileSync(lock, "utf8")) === process.pid) fs.unlinkSync(lock);
        } catch {}
      });
      return;
    } catch (error) {
      if (error instanceof UnsafeDirectoryError || error instanceof UnsafeFileError) throw error;
    }
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
