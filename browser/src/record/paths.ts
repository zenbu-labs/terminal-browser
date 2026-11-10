import fs from "node:fs";
import path from "node:path";
import { urlHost } from "../url";

const OUTPUT_ROOT = "/tmp/recordings";

export function stampedName(pageUrl: string): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const slug = urlHost(pageUrl).replace(/[^a-z0-9.-]/gi, "").slice(0, 40) || "page";
  return `${slug}-${time}`;
}

export function newRecordingDir(pageUrl: string): string {
  const base = path.join(OUTPUT_ROOT, stampedName(pageUrl));
  for (let i = 0; ; i++) {
    const dir = i === 0 ? base : `${base}-${i + 1}`;
    if (!fs.existsSync(dir)) return dir;
  }
}
