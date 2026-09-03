import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { urlHost } from "../url";

const OUTPUT_ROOT =
  process.platform === "win32" ? path.join(os.tmpdir(), "recordings") : "/tmp/recordings";

export function newRecordingDir(pageUrl: string): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const slug = urlHost(pageUrl).replace(/[^a-z0-9.-]/gi, "").slice(0, 40) || "page";
  const base = path.join(OUTPUT_ROOT, `${slug}-${time}`);
  for (let i = 0; ; i++) {
    const dir = i === 0 ? base : `${base}-${i + 1}`;
    if (!fs.existsSync(dir)) return dir;
  }
}
