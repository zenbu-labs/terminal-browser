import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { nativeImage } from "electron";
import type { Session } from "electron";

import { FAVICONS_DIR } from "pixel-store";

export class FaviconCache {
  constructor(private readonly dir: string = FAVICONS_DIR) {}

  async resolve(urls: string[], ses: Session): Promise<string | null> {
    const url = urls.find((u) => /\.(png|jpe?g|webp)(\?|$)/i.test(u)) ?? urls[0];
    if (!url) return null;
    const stem = path.join(
      this.dir,
      crypto
        .createHash("sha1")
        .update(`${ses.storagePath ?? ""}\0${url}`)
        .digest("hex")
        .slice(0, 16),
    );
    const cached = [`${stem}.png`, `${stem}.ico`].find((file) => fs.existsSync(file));
    if (cached) return cached;
    const response = await ses.fetch(url);
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
