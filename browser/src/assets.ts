import fs from "node:fs";
import path from "node:path";

export function bundledAsset(relative: string): string | null {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "assets", relative);
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}
