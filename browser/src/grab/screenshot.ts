import fs from "node:fs";
import path from "node:path";
import { ClipboardItem, clipboard } from "electron";
import type { NativeImage, Rectangle, WebContents } from "electron";
import type { WebViewHandle } from "@zenbu-labs/pixel";
import { stampedName } from "../record/paths";
import type { GrabRegion } from "./grab";
import type { Screenshot } from "./target";

const OUTPUT_ROOT = "/tmp/terminal-browser/screenshots";
const CAPTION_MAX_LINES = 24;

const OVERLAY = `document.querySelector("[data-react-grab]")`;
const HIDE_OVERLAY = `(() => {
  const host = ${OVERLAY};
  if (host) host.style.visibility = "hidden";
  return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
})()`;
const SHOW_OVERLAY = `${OVERLAY}?.style.removeProperty("visibility")`;

const DRAW_CAPTION = `(async (args) => {
  const image = new Image();
  image.src = args.png;
  await image.decode();
  const scale = image.naturalWidth / args.cssWidth;
  const fontSize = Math.round(13 * scale);
  const lineHeight = Math.round(fontSize * 1.45);
  const pad = Math.round(14 * scale);
  const canvas = document.createElement("canvas");
  const font = fontSize + "px ui-monospace, Menlo, monospace";
  let ctx = canvas.getContext("2d");
  ctx.font = font;
  const maxWidth = image.naturalWidth - pad * 2;
  const wrap = (text) => {
    const lines = [];
    let line = "";
    for (const word of text.split(" ")) {
      const next = line ? line + " " + word : word;
      if (line && ctx.measureText(next).width > maxWidth) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
    return lines;
  };
  const lines = args.text.split("\\n").flatMap(wrap);
  if (lines.length > args.maxLines) lines.splice(args.maxLines, lines.length, "…");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight + pad * 2 + lines.length * lineHeight;
  ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  ctx.fillStyle = "#16161a";
  ctx.fillRect(0, image.naturalHeight, canvas.width, canvas.height - image.naturalHeight);
  ctx.font = font;
  ctx.fillStyle = "#e6e6eb";
  ctx.textBaseline = "top";
  lines.forEach((text, i) => ctx.fillText(text, pad, image.naturalHeight + pad + i * lineHeight));
  return canvas.toDataURL("image/png");
})`;

function zoomed(contents: WebContents, region: GrabRegion): Rectangle {
  const zoom = contents.getZoomFactor();
  return {
    x: Math.round(region.x * zoom),
    y: Math.round(region.y * zoom),
    width: Math.max(1, Math.round(region.width * zoom)),
    height: Math.max(1, Math.round(region.height * zoom)),
  };
}

async function captureRegion(view: WebViewHandle, region: GrabRegion): Promise<NativeImage | null> {
  const contents = view.webContents;
  await contents.executeJavaScript(HIDE_OVERLAY, true).catch(() => {});
  try {
    const image = await contents.capturePage(zoomed(contents, region));
    return image.isEmpty() ? null : image;
  } finally {
    void contents.executeJavaScript(SHOW_OVERLAY, true).catch(() => {});
  }
}

function saveScreenshot(png: Buffer, pageUrl: string): string {
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  const base = path.join(OUTPUT_ROOT, stampedName(pageUrl));
  for (let i = 0; ; i++) {
    const file = i === 0 ? `${base}.png` : `${base}-${i + 1}.png`;
    if (fs.existsSync(file)) continue;
    fs.writeFileSync(file, png);
    return file;
  }
}

async function captionImage(view: WebViewHandle, png: Buffer, cssWidth: number, text: string): Promise<Buffer> {
  const args = { png: `data:image/png;base64,${png.toString("base64")}`, cssWidth, text, maxLines: CAPTION_MAX_LINES };
  const dataUrl = (await view.webContents.executeJavaScript(`(${DRAW_CAPTION})(${JSON.stringify(args)})`, true)) as string;
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

const pngBlob = (png: Buffer) => new Blob([new Uint8Array(png)], { type: "image/png" });

export interface GrabScreenshot extends Screenshot {
  // text/plain is the bare content, image/png has the content drawn under the screenshot
  copyWithText(): Promise<void>;
}

export async function grabScreenshot(
  view: WebViewHandle,
  region: GrabRegion,
  content: string,
  pageUrl: string,
): Promise<GrabScreenshot | null> {
  const image = await captureRegion(view, region).catch(() => null);
  if (!image) return null;
  const png = image.toPNG();
  let saved: string | null = null;
  const file = () => (saved ??= saveScreenshot(png, pageUrl));
  return {
    file,
    copyToClipboard: () => clipboard.write([new ClipboardItem({ "image/png": pngBlob(png) })]),
    async copyWithText() {
      const captioned = await captionImage(view, png, region.width, content).catch(() => png);
      await clipboard.write([new ClipboardItem({ "text/plain": content, "image/png": pngBlob(captioned) })]);
    },
  };
}
