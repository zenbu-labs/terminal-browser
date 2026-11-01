import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { webContents as allWebContents } from "electron";

import type { LoadedExtension } from "../loaded";
import type { ExtensionService } from "../service";

const TAB_CLOSED = "Cannot find the tab for this request.";
const NOT_ALLOWED = "Don't have permissions required to capture this page.";
const GENERATION_FAILED = "Failed to generate MHTML.";
const TOO_BIG = "The MHTML file generated is too big.";
const WEBSTORE_ORIGINS = new Set(["https://chrome.google.com", "https://chromewebstore.google.com"]);
const INTERNAL_SCHEMES = new Set(["chrome:", "terminal-browser:", "chrome-extension:", "data:"]);

// Chrome's PermissionsData::CanCaptureVisiblePage with the pageCapture requirement.
export function canCapturePage(extension: LoadedExtension, tabId: number, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "file:") return extension.allowsFileAccess;
  if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !WEBSTORE_ORIGINS.has(parsed.origin)) return true;
  if (parsed.protocol === "chrome-extension:" && parsed.host === extension.id) return true;
  const needsActiveTab = INTERNAL_SCHEMES.has(parsed.protocol) || WEBSTORE_ORIGINS.has(parsed.origin);
  return needsActiveTab && extension.hasActiveTab(tabId, url);
}

export function installPageCapture(service: ExtensionService) {
  service.router.handle(
    "pageCapture.saveAsMHTML",
    async (caller, details) => {
      const { tabId } = details as { tabId: number };
      const isTab = service.tabRef(tabId) !== null || service.popupWindowForContents(tabId) !== null;
      const contents = isTab ? allWebContents.fromId(tabId) : undefined;
      if (!contents || contents.isDestroyed()) throw new Error(TAB_CLOSED);
      if (!canCapturePage(caller.extension, tabId, contents.mainFrame.url)) throw new Error(NOT_ALLOWED);
      const file = path.join(os.tmpdir(), `tb-page-capture-${crypto.randomUUID()}.mhtml`);
      try {
        await contents.savePage(file, "MHTML").catch(() => {
          throw new Error(contents.isDestroyed() ? TAB_CLOSED : GENERATION_FAILED);
        });
        const size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
        if (size <= 0) throw new Error(GENERATION_FAILED);
        if (size > 2 ** 31 - 1) throw new Error(TOO_BIG);
        return new Uint8Array(fs.readFileSync(file));
      } finally {
        fs.rmSync(file, { force: true });
      }
    },
    { permission: "pageCapture" },
  );
}
