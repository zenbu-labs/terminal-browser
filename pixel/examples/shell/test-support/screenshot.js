const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { Vt } = require("../dist/terminal/vt.js");

const PALETTE = [
  [29, 31, 33], [204, 102, 102], [181, 189, 104], [240, 198, 116], [129, 162, 190], [178, 148, 187], [138, 190, 183], [197, 200, 198],
  [150, 152, 150], [204, 102, 102], [181, 189, 104], [240, 198, 116], [129, 162, 190], [178, 148, 187], [138, 190, 183], [255, 255, 255],
];
const FG = [220, 223, 228];
const BG = [30, 32, 38];
const DIACRITICS = [0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346, 0x034a, 0x034b, 0x034c, 0x0350, 0x0351, 0x0352, 0x0357, 0x035b, 0x0363, 0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369, 0x036a, 0x036b, 0x036c, 0x036d, 0x036e, 0x036f, 0x0483, 0x0484, 0x0485, 0x0486, 0x0487, 0x0592, 0x0593, 0x0594, 0x0595, 0x0597, 0x0598, 0x0599, 0x059c, 0x059d, 0x059e, 0x059f, 0x05a0, 0x05a1, 0x05a8, 0x05a9, 0x05ab, 0x05ac, 0x05af, 0x05c4, 0x0610, 0x0611, 0x0612, 0x0613, 0x0614, 0x0615, 0x0616, 0x0617, 0x0657, 0x0658, 0x0659, 0x065a, 0x065b, 0x065d, 0x065e, 0x06d6, 0x06d7, 0x06d8, 0x06d9, 0x06da, 0x06db, 0x06dc, 0x06df, 0x06e0, 0x06e1, 0x06e2, 0x06e4, 0x06e7, 0x06e8, 0x06eb, 0x06ec, 0x0730, 0x0732, 0x0733, 0x0735, 0x0736, 0x073a, 0x073d, 0x073f, 0x0740, 0x0741, 0x0743, 0x0745, 0x0747, 0x0749, 0x074a, 0x07eb, 0x07ec, 0x07ed, 0x07ee, 0x07ef, 0x07f0, 0x07f1, 0x07f3, 0x0816, 0x0817, 0x0818, 0x0819, 0x081b, 0x081c, 0x081d, 0x081e, 0x081f, 0x0820, 0x0821, 0x0822, 0x0823, 0x0825, 0x0826, 0x0827, 0x0829, 0x082a, 0x082b, 0x082c, 0x082d, 0x0951, 0x0953, 0x0954, 0x0f82, 0x0f83, 0x0f86, 0x0f87, 0x135d, 0x135e, 0x135f, 0x17dd, 0x193a, 0x1a17, 0x1a75, 0x1a76, 0x1a77, 0x1a78, 0x1a79, 0x1a7a, 0x1a7b, 0x1a7c, 0x1b6b, 0x1b6d, 0x1b6e, 0x1b6f, 0x1b70, 0x1b71, 0x1b72, 0x1b73, 0x1cd0, 0x1cd1, 0x1cd2, 0x1cda, 0x1cdb, 0x1ce0, 0x1dc0, 0x1dc1, 0x1dc3, 0x1dc4, 0x1dc5, 0x1dc6, 0x1dc7, 0x1dc8, 0x1dc9, 0x1dcb, 0x1dcc, 0x1dd1, 0x1dd2, 0x1dd3, 0x1dd4, 0x1dd5, 0x1dd6, 0x1dd7, 0x1dd8, 0x1dd9, 0x1dda, 0x1ddb, 0x1ddc, 0x1ddd, 0x1dde, 0x1ddf, 0x1de0, 0x1de1, 0x1de2, 0x1de3, 0x1de4, 0x1de5, 0x1de6, 0x1dfe, 0x20d0, 0x20d1, 0x20d4, 0x20d5, 0x20d6, 0x20d7, 0x20db, 0x20dc, 0x20e1, 0x20e7, 0x20e9, 0x20f0];

function color(c, fallback) {
  if (!c) return fallback;
  if ("rgb" in c) return c.rgb;
  return PALETTE[c.palette] ?? fallback;
}

const css = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
const escape = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function render({ capture, frames, at, out, cols = 100, rows = 30, cw = 10, ch = 20 }) {
  const vt = new Vt(cols, rows, { scrollback: 1000 });
  vt.write(capture.subarray(0, at));
  const pngs = new Map();
  const frameFor = (id) => {
    const frame = frames.filter((f) => f.id === id && f.offset <= at).at(-1);
    if (!frame) return null;
    if (!pngs.has(frame.file)) {
      const pngNextToSvg = path.join(path.dirname(out), `${path.basename(out, ".png")}-${path.basename(frame.file, ".rgba")}.png`);
      execFileSync("magick", ["-size", `${frame.width}x${frame.height}`, "-depth", "8", `rgba:${frame.file}`, pngNextToSvg]);
      pngs.set(frame.file, pngNextToSvg);
    }
    return { ...frame, png: pngs.get(frame.file) };
  };
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${cols * cw}" height="${rows * ch}">`, `<rect width="100%" height="100%" fill="${css(BG)}"/>`];
  const info = vt.info();
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const cell = vt.cell(x, y);
      if (cell.spacer) continue;
      const style = cell.style;
      let fg = color(style?.fg, FG);
      let bg = color(style?.bg, null);
      if (style?.inverse) [fg, bg] = [bg ?? BG, fg];
      const width = cell.wide ? 2 : 1;
      const cp = cell.text.codePointAt(0);
      if (cp === 0x10eeee) {
        const id = style?.fg && "rgb" in style.fg ? (style.fg.rgb[0] << 16) | (style.fg.rgb[1] << 8) | style.fg.rgb[2] : 0;
        const marks = [...cell.text].slice(1).map((c) => DIACRITICS.indexOf(c.codePointAt(0)));
        const frame = frameFor(id);
        if (frame && marks.length >= 2) {
          const [row, col] = marks;
          const sw = frame.width / frame.cols;
          const sh = frame.height / frame.rows;
          parts.push(`<svg x="${x * cw}" y="${y * ch}" width="${cw}" height="${ch}" viewBox="${col * sw} ${row * sh} ${sw} ${sh}" preserveAspectRatio="none"><image xlink:href="${path.basename(frame.png)}" width="${frame.width}" height="${frame.height}"/></svg>`);
        }
        continue;
      }
      if (bg) parts.push(`<rect x="${x * cw}" y="${y * ch}" width="${width * cw}" height="${ch}" fill="${css(bg)}"/>`);
      if (cell.text && cell.text !== " ") {
        const weight = style?.bold ? "bold" : "normal";
        parts.push(`<text x="${x * cw}" y="${y * ch + ch * 0.75}" font-family="Menlo, monospace" font-size="${ch * 0.7}" font-weight="${weight}" fill="${css(fg)}">${escape(cell.text)}</text>`);
      }
    }
  }
  if (info.cursorVisible) parts.push(`<rect x="${info.cursorX * cw}" y="${info.cursorY * ch}" width="${cw}" height="${ch}" fill="none" stroke="${css(FG)}"/>`);
  parts.push("</svg>");
  const svg = out.replace(/\.png$/, ".svg");
  fs.writeFileSync(svg, parts.join("\n"));
  execFileSync("rsvg-convert", ["-o", out, svg]);
  return out;
}

module.exports = { render };

if (require.main === module) {
  const [captureFile, framesDir, at, out, cols, rows, cw, ch] = process.argv.slice(2);
  if (!out) {
    // fixme: placeholder copy
    console.error("usage: node test-support/screenshot.js <capture.bin> <frames dir> <offset | mark name> <out.png> [cols rows cellW cellH]");
    process.exit(1);
  }
  const capture = fs.readFileSync(captureFile);
  const marks = fs.existsSync(captureFile + ".marks.json") ? JSON.parse(fs.readFileSync(captureFile + ".marks.json", "utf8")) : {};
  const frames = fs.existsSync(path.join(framesDir, "frames.json")) ? JSON.parse(fs.readFileSync(path.join(framesDir, "frames.json"), "utf8")) : [];
  const offset = /^\d+$/.test(at) ? Number(at) : at === "end" ? capture.length : marks[at];
  console.log(render({ capture, frames, at: offset, out, cols: Number(cols ?? 100), rows: Number(rows ?? 30), cw: Number(cw ?? 10), ch: Number(ch ?? 20) }));
}
