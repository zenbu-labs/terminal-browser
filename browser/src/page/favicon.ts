import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { nativeImage } from "electron";
import type { Session } from "electron";

import { FAVICONS_DIR } from "pixel-store";

const RASTER_URL = /\.(png|jpe?g|webp|gif)(\?|$)/i;

function isIco(data: Buffer): boolean {
  return (
    data.length > 4 && data[0] === 0 && data[1] === 0 && data[2] === 1 && data[3] === 0
  );
}

export class FaviconCache {
  constructor(private readonly dir: string = FAVICONS_DIR) {}

  async resolve(urls: string[], ses: Session): Promise<string | null> {
    if (urls.length === 0) return null;
    const candidates = [...urls].sort(
      (a, b) => Number(RASTER_URL.test(b)) - Number(RASTER_URL.test(a)),
    );
    try {
      const fallback = new URL("/favicon.ico", urls[0]).toString();
      if (!candidates.includes(fallback)) candidates.push(fallback);
    } catch {}
    const stem = path.join(
      this.dir,
      crypto
        .createHash("sha1")
        .update(`${ses.storagePath ?? ""}\0${candidates.join("\n")}`)
        .digest("hex")
        .slice(0, 16),
    );
    const cached = [`${stem}.png`, `${stem}.ico`].find((file) => fs.existsSync(file));
    if (cached) return cached;
    for (const url of candidates) {
      const file = await this.fetchDecodable(url, ses, stem);
      if (file) return file;
    }
    return null;
  }

  private async fetchDecodable(
    url: string,
    ses: Session,
    stem: string,
  ): Promise<string | null> {
    try {
      const response = await ses.fetch(url);
      if (!response.ok) return null;
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length === 0) return null;
      const decoded = nativeImage.createFromBuffer(data);
      if (!decoded.isEmpty()) {
        const file = `${stem}.png`;
        fs.mkdirSync(this.dir, { recursive: true });
        await fs.promises.writeFile(file, decoded.resize({ width: 32, height: 32 }).toPNG());
        return file;
      }
      if (isIco(data)) {
        const file = `${stem}.ico`;
        fs.mkdirSync(this.dir, { recursive: true });
        await fs.promises.writeFile(file, data);
        return file;
      }
      return null;
    } catch {
      return null;
    }
  }
}
