import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { net, nativeImage } from "electron";

import { FAVICONS_DIR } from "pixel-store";
import { browserUserAgent } from "../user-agent";

export class FaviconCache {
  constructor(private readonly dir: string = FAVICONS_DIR) {}

  async resolve(urls: string[]): Promise<string | null> {
    const url = urls.find((u) => /\.(png|jpe?g|webp)(\?|$)/i.test(u)) ?? urls[0];
    if (!url) return null;
    const stem = path.join(
      this.dir,
      crypto.createHash("sha1").update(url).digest("hex").slice(0, 16),
    );
    const cached = [`${stem}.png`, `${stem}.ico`].find((file) => fs.existsSync(file));
    if (cached) return cached;
    const response = await net.fetch(url, { headers: { "User-Agent": browserUserAgent() } });
    if (!response.ok) return null;
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length === 0) return null;
    fs.mkdirSync(this.dir, { recursive: true });
    const decoded = nativeImage.createFromBuffer(data);
    const file = decoded.isEmpty() ? `${stem}.ico` : `${stem}.png`;
    await fs.promises.writeFile(
      file,
      decoded.isEmpty() ? data : decoded.resize({ width: 32, height: 32 }).toPNG(),
    );
    return file;
  }
}
