#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { parseArgs } from "node:util";

import { SCRATCH, sleep, startBrowser } from "../extensions-conformance/harness/tb.mjs";

// fixme: placeholder copy
const HELP = `Opens every menu, popup and prompt in a headless terminal-browser and checks, frame by
frame, that the first frame showing it already has it where and how it settles, and that
surfaces anchored to the toolbar stay on their anchor in every frame while the pane resizes.

Usage:
  run.mjs [--electron <bin>] [--out <dir>] [--only <regex>] [--shots]

Options:
  --electron <bin>   Electron binary (default: TB_ELECTRON, else pixel's installed Electron)
  --out <dir>        Where frames of failures (and --shots) go (default: a new temp directory)
  --only <regex>     Only run checks whose name matches
  --shots            Also save the first and settled frame of passing checks
  -h, --help         Show this help`;

const { values: opts } = parseArgs({
  options: {
    electron: { type: "string" },
    out: { type: "string" },
    only: { type: "string" },
    shots: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (opts.help) {
  console.log(HELP);
  process.exit(0);
}

const HERE = path.dirname(new URL(import.meta.url).pathname);
const out = path.resolve(opts.out ?? fs.mkdtempSync(path.join(os.tmpdir(), "tb-first-frame-")));
fs.mkdirSync(out, { recursive: true });
const only = opts.only ? new RegExp(opts.only) : null;

const PAGE = `<!doctype html><html><body style="margin:0;background:#1d2027;height:100vh"></body></html>`;
const server = http.createServer((req, res) => {
  if (req.url === "/auth") {
    res.writeHead(401, { "www-authenticate": 'Basic realm="first-frame"', "content-type": "text/html" });
    return res.end("denied");
  }
  if (req.url === "/download") {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="first-frame.txt"' });
    return res.end("first frame\n");
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(PAGE);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const site = `http://localhost:${server.address().port}`;

const cols = 140, rows = 46;
// Layout measurements reach the UI this much later than they would, so every frame drawn
// while one is outstanding is presented and checked rather than lucky enough to be skipped.
const LAYOUT_DELAY_MS = Number(process.env.TB_TEST_LAYOUT_DELAY_MS ?? 500);
const home = fs.mkdtempSync(path.join(SCRATCH, "tbff-"));
const downloads = path.join(home, "downloads");
fs.mkdirSync(downloads, { recursive: true });
const tb = await startBrowser({
  electron: opts.electron,
  out: path.join(out, "browser"),
  home,
  label: "first-frame",
  url: `${site}/`,
  cols,
  rows,
  extensions: [path.join(HERE, "extension")],
  config: { "toolbar.extensions": "on" },
  // The same pixel density as the CI runners, whatever screen this machine has.
  env: { HOME: home, TB_TEST_LAYOUT_DELAY_MS: String(LAYOUT_DELAY_MS), PIXEL_DISPLAY_SCALE: "1" },
});

await tb.mainEval(`
  const { app, shell } = req("electron");
  app.setPath("downloads", ${JSON.stringify(downloads)});
  shell.openPath = async () => "";
  shell.openExternal = async () => {};
  shell.showItemInFolder = () => {};
`);

// Toolbar buttons, from the right edge, at the harness's 16px rem.
const toolbarY = 16;
const at = {
  more: () => tb.width - 18,
  puzzle: () => tb.width - 71,
  action: () => tb.width - 97,
  url: () => tb.width / 2,
};
const pageArea = (frame) => ({ x: 0, y: 36, width: frame.width, height: frame.height - 36 });
const isPage = (t) => t.type === "page" && t.url.startsWith(site);

let frames = [];
tb.onFrame((frame) => frames.push(frame));

// Settled once no frame has come for longer than a held-back layout measurement takes.
async function quiet(ms = LAYOUT_DELAY_MS + 300, max = 8000) {
  const end = Date.now() + max;
  let count = frames.length;
  let since = Date.now();
  while (Date.now() < end) {
    await sleep(50);
    if (frames.length !== count) {
      count = frames.length;
      since = Date.now();
    } else if (Date.now() - since >= ms) break;
  }
  return tb.frame();
}

const whole = (frame) => ({ x: 0, y: 0, width: frame.width, height: frame.height });
const close = (a, i, b, j) =>
  Math.abs(a.bytes[i] - b.bytes[j]) + Math.abs(a.bytes[i + 1] - b.bytes[j + 1]) + Math.abs(a.bytes[i + 2] - b.bytes[j + 2]) <= 24;

function bbox(a, b, within = whole(a), pad = 2) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = within.y; y < within.y + within.height; y++) {
    for (let x = within.x; x < within.x + within.width; x++) {
      const i = (y * a.width + x) * 4;
      if (close(a, i, b, i)) continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  if (x1 < 0) return null;
  const left = Math.max(within.x, x0 - pad), top = Math.max(within.y, y0 - pad);
  return { x: left, y: top, width: Math.min(within.x + within.width, x1 + pad + 1) - left, height: Math.min(within.y + within.height, y1 + pad + 1) - top };
}

// How many pixels of `region` in `a` differ from the same-sized region at `other` in `b`.
function differing(a, b, region, other = region) {
  if (a.height !== b.height || (other === region && a.width !== b.width)) return Infinity;
  let n = 0;
  for (let y = 0; y < region.height; y++) {
    for (let x = 0; x < region.width; x++) {
      if (!close(a, ((region.y + y) * a.width + region.x + x) * 4, b, ((other.y + y) * b.width + other.x + x) * 4)) n++;
    }
  }
  return n;
}

// Pixels of `frame` that match neither the frame before the surface opened nor the
// settled one: what a surface drawn somewhere else, or at another size, leaves behind.
function strays(frame, before, settled, region) {
  if (frame.width !== settled.width || frame.height !== settled.height) return Infinity;
  let n = 0;
  for (let y = region.y; y < region.y + region.height; y++) {
    for (let x = region.x; x < region.x + region.width; x++) {
      const i = (y * frame.width + x) * 4;
      if (!close(frame, i, before, i) && !close(frame, i, settled, i)) n++;
    }
  }
  return n;
}

function png(frame, region = whole(frame)) {
  const { width, height } = region;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = ((region.y + y) * frame.width + region.x + x) * 4, o = y * (width * 3 + 1) + 1 + x * 3;
      const alpha = frame.bytes[i + 3] / 255;
      raw[o] = Math.round(frame.bytes[i + 2] * alpha + 24 * (1 - alpha));
      raw[o + 1] = Math.round(frame.bytes[i + 1] * alpha + 24 * (1 - alpha));
      raw[o + 2] = Math.round(frame.bytes[i] * alpha + 28 * (1 - alpha));
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function save(name, frame, region) {
  const file = path.join(out, `${name.replace(/[^\w-]+/g, "-")}.png`);
  fs.writeFileSync(file, png(frame, region));
  return file;
}

// Small changes such as a blinking caret are not a surface moving.
const tolerance = (region) => Math.max(48, Math.round(region.width * region.height * 0.002));

// Every frame drawn while the surface opens may only show pixels of the frame before it
// opened or of the settled frame. Surfaces whose text changes on its own (a download's
// status, the address field turning into a keyword chip) are held to their outline
// instead: the box they cover, against the frame before the check began, must not move
// or resize.
function checkOpening(name, { start, before, during, settled }, { area, outline }) {
  const within = area?.(settled) ?? whole(settled);
  const region = bbox(before, settled, within);
  if (!region) return { name, ok: false, why: "nothing appeared", before: save(`${name} before`, before), settled: save(`${name} settled`, settled) };
  const tol = tolerance(region);
  const shown = during.filter((frame) => differing(frame, before, region) > tol);
  const box = outline && bbox(start, settled, within);
  const wrong = (frame) => {
    if (!outline) return strays(frame, before, settled, region) > tol;
    const drawn = bbox(start, frame, within);
    return !drawn || ["x", "y", "width", "height"].some((key) => Math.abs(drawn[key] - box[key]) > 1);
  };
  const bad = shown.find(wrong);
  const result = { name, ok: !bad, region, settledFrame: settled, frames: during.length, shownFrames: shown.length };
  if (bad || opts.shots) {
    if (shown[0]) result.first = save(`${name} first`, shown[0], box || region);
    result.settled = save(`${name} settled`, settled, box || region);
    result.settledFull = save(`${name} settled full`, settled);
    result.beforeFull = save(`${name} before full`, before);
  }
  if (bad) {
    result.bad = save(`${name} wrong`, bad, box || region);
    result.badFull = save(`${name} wrong full`, bad);
    const which = `frame ${shown.indexOf(bad) + 1} of ${shown.length} showing it`;
    result.why = outline
      ? `drawn at ${JSON.stringify(bbox(start, bad, within))}, settles at ${JSON.stringify(box)} (${which})`
      : `${strays(bad, before, settled, region)} pixels are neither the frame before nor the settled one (${which})`;
  }
  return result;
}

// While the pane narrows, a surface anchored to the right edge must settle at the same
// distance from it, and every frame whose toolbar is already laid out at the new width
// must show it there too.
async function checkResize(name, opened, newCols) {
  const region = { ...opened.region, x: opened.region.x + (newCols - cols) * tb.cell.width };
  frames = [];
  tb.resize(newCols, rows);
  const settled = await quiet();
  const during = frames;
  tb.resize(cols, rows);
  await quiet();
  const result = { name, region, frames: during.length };
  const moved = differing(settled, opened.settledFrame, region, opened.region);
  if (moved > tolerance(region)) {
    result.ok = false;
    result.settled = save(`${name} settled`, settled, region);
    result.badFull = save(`${name} settled full`, settled);
    result.why = `settled with ${moved} pixels different from before the resize, at the same distance from the right edge`;
    return result;
  }
  const bar = { x: 0, y: 0, width: settled.width, height: 28 };
  const laidOut = during.filter((frame) => differing(frame, settled, bar) <= tolerance(bar));
  const bad = laidOut.find((frame) => differing(frame, settled, region) > tolerance(region));
  result.ok = !bad;
  result.laidOutFrames = laidOut.length;
  if (bad) {
    result.bad = save(`${name} wrong`, bad, region);
    result.badFull = save(`${name} wrong full`, bad);
    result.settled = save(`${name} settled`, settled, region);
    result.why = `${differing(bad, settled, region)} pixels differ from the settled frame (frame ${laidOut.indexOf(bad) + 1} of ${laidOut.length} with the toolbar in place)`;
  }
  return result;
}

const click = (x, y, button) => tb.click(x, y, button);
const escape = async () => {
  await tb.key("escape");
  await quiet();
};
const pageEval = (expression) => tb.evalIn(isPage, expression);

// Menu rows counted up from the card's bottom edge, at the harness's 16px rem
// (rows 27px, card padding 4px, the … menu's zoom row and its divider below the items).
const ROW = 27, PAD = 4, DIVIDER = 9;
const fromBottom = {
  "more menu": { Extensions: PAD + ROW + DIVIDER + ROW * 2 },
  "toolbar icon menu": { Remove: PAD },
};
const settledRegions = new Map();
function rowOf(menu, label) {
  const region = settledRegions.get(menu);
  if (!region) throw new Error(`${menu} was not measured`);
  const bottom = region.y + region.height - 3;
  return [region.x + region.width / 2, bottom - fromBottom[menu][label] - ROW / 2];
}

const checks = [
  {
    name: "puzzle menu",
    hover: () => [at.puzzle(), toolbarY],
    open: () => click(at.puzzle(), toolbarY),
    resize: true,
  },
  {
    name: "more menu",
    hover: () => [at.more(), toolbarY],
    open: () => click(at.more(), toolbarY),
    resize: true,
  },
  {
    name: "more menu extensions submenu",
    before: () => click(at.more(), toolbarY),
    hover: () => [tb.width - 120, 4],
    open: () => tb.move(...rowOf("more menu", "Extensions")),
    close: async () => {
      await escape();
      await escape();
    },
  },
  {
    name: "toolbar icon menu",
    hover: () => [at.action(), toolbarY],
    // Long enough for the icon's tooltip to show, as it does when you aim before right-clicking.
    hoverMs: 1200,
    open: () => click(at.action(), toolbarY, "right"),
  },
  {
    name: "remove prompt",
    before: () => click(at.action(), toolbarY, "right"),
    hover: () => rowOf("toolbar icon menu", "Remove"),
    open: () => click(...rowOf("toolbar icon menu", "Remove")),
  },
  {
    name: "action popup",
    hover: () => [at.action(), toolbarY],
    // A click hides the icon's tooltip at once, but the card only shows once its page has
    // painted, so a tooltip in the frame before would count against the popup.
    clickBeforeTooltip: true,
    open: () => click(at.action(), toolbarY),
    resize: true,
  },
  {
    name: "page context menu",
    hover: () => [400, 300],
    open: () => click(400, 300, "right"),
  },
  {
    name: "address dropdown",
    hover: () => [at.url(), toolbarY],
    open: () => click(at.url(), toolbarY),
  },
  {
    name: "address keyword mode",
    before: async () => {
      await tb.key("l", { mods: { super: true } });
      await quiet();
      await tb.type("ff");
    },
    outline: true,
    open: () => tb.type(" "),
  },
  {
    name: "palette",
    open: () => tb.key("p", { mods: { super: true } }),
  },
  {
    name: "auth prompt",
    area: pageArea,
    open: () => pageEval(`location.href = "/auth"`),
    close: async () => {
      await escape();
      await pageEval(`location.href = "/"`).catch(() => {});
      await quiet();
    },
  },
  {
    name: "permission prompt",
    area: pageArea,
    open: () => pageEval(`Notification.requestPermission(); 1`),
  },
  {
    name: "download corner",
    area: pageArea,
    outline: true,
    open: () => pageEval(`location.href = "/download"`),
    close: async () => {
      await sleep(4000);
      await quiet();
    },
  },
];

// A security prompt that opens while an extension's popup window or action popup covers it
// has to show on top, take the clicks aimed at it, and be what Escape dismisses.
async function promptsAboveExtensionSurfaces() {
  const isPopup = (name) => (t) => t.url.startsWith("chrome-extension://") && t.url.endsWith(`/${name}`);
  const isCover = isPopup("cover.html");
  // The extension's service worker stops when idle, so its APIs are called from its action popup.
  const openAction = async (page) => {
    await tb.move(at.action(), toolbarY);
    await quiet();
    await click(at.action(), toolbarY);
    await tb.waitTarget(isPopup(page));
    await quiet();
  };
  const fromAction = async (expression) => {
    await openAction("popup.html");
    await tb.evalIn(isPopup("popup.html"), expression);
    await quiet();
    if ((await tb.targets()).some(isPopup("popup.html"))) await escape();
  };
  const auth = {
    name: "auth prompt",
    open: () => pageEval(`location.href = "/auth"`),
    after: async () => {
      await pageEval(`location.href = "/"`).catch(() => {});
      await quiet();
    },
  };
  const permission = { name: "permission prompt", open: () => pageEval(`Notification.requestPermission(); 1`) };
  const checked = [];
  for (const prompt of [auth, permission]) {
    await fromAction(`chrome.windows.create({ url: "cover.html", type: "popup", width: 4000, height: 4000 }).then(() => 1)`);
    try {
      await tb.waitTarget(isCover);
      await quiet();
      checked.push(await promptAbove(`${prompt.name} above an extension popup window`, prompt, isCover));
    } finally {
      await tb.evalIn(isCover, `chrome.windows.getCurrent().then((w) => chrome.windows.remove(w.id))`, 1000).catch(() => {});
      await quiet();
    }
  }
  await fromAction(`chrome.action.setPopup({ popup: "cover.html" }).then(() => 1)`);
  try {
    await openAction("cover.html");
    checked.push(await promptAbove("permission prompt above an action popup", permission, isCover));
  } finally {
    if (!(await tb.targets()).some(isCover)) await openAction("cover.html");
    await tb.evalIn(isCover, `chrome.action.setPopup({ popup: "popup.html" }).then(() => 1)`);
    await escape();
  }
  return checked;
}

async function promptAbove(name, prompt, isSurface) {
  const alone = results.find((result) => result.name === prompt.name);
  if (!alone?.region) return { name, ok: false, why: `${prompt.name} was not measured on its own` };
  // Away from the card's rounded corners, where what is behind it shows through.
  const inset = 16;
  const card = { x: alone.region.x + inset, y: alone.region.y + inset, width: alone.region.width - inset * 2, height: alone.region.height - inset * 2 };
  await tb.move(tb.width / 2, tb.height - 4);
  await tb.evalIn(isSurface, `globalThis.inputs = []; 1`);
  await prompt.open();
  const settled = await quiet();
  const hidden = differing(settled, alone.settledFrame, card);
  await click(card.x + card.width / 2, card.y + card.height / 2);
  const stolen = await tb.evalIn(isSurface, `globalThis.inputs.length`);
  await escape();
  const kept = (await tb.targets()).some(isSurface);
  if (!kept) await escape();
  await prompt.after?.();
  const result = { name, region: card, ok: hidden <= tolerance(card) && stolen === 0 && kept };
  if (!result.ok) {
    result.why = `${hidden} pixels of the prompt differ from it shown alone, the extension got ${stolen} clicks aimed at the prompt, and Escape ${kept ? "dismissed the prompt" : "closed the extension's surface"}`;
    result.settled = save(`${name} settled`, settled);
    result.before = save(`${name} alone`, alone.settledFrame);
  }
  return result;
}

const results = [];
try {
  await quiet(800, 10000);
  for (const check of checks) {
    if (only && !only.test(check.name)) continue;
    try {
      const start = await quiet();
      if (check.before) {
        await check.before();
        await quiet();
      }
      const hover = check.hover?.();
      if (hover) {
        await tb.move(...hover);
        if (check.hoverMs) await sleep(check.hoverMs);
        if (!check.clickBeforeTooltip) await quiet();
      }
      const before = check.clickBeforeTooltip ? (await sleep(250), tb.frame()) : await quiet();
      frames = [];
      await check.open();
      const settled = await quiet();
      const result = checkOpening(check.name, { start, before, during: frames, settled }, check);
      if (result.region) settledRegions.set(check.name, result.region);
      results.push(result);
      if (check.resize && result.region) results.push(await checkResize(`${check.name} while resizing`, result, cols - 30));
      await (check.close ?? escape)();
    } catch (error) {
      results.push({ name: check.name, ok: false, why: error.message });
      await escape().catch(() => {});
    }
  }
  if (!only || only.test("prompt above")) {
    try {
      results.push(...(await promptsAboveExtensionSurfaces()));
    } catch (error) {
      results.push({ name: "prompts above extension surfaces", ok: false, why: error.message });
      await escape().catch(() => {});
    }
  }
} finally {
  await tb.stop();
  server.close();
}

let failed = 0;
for (const result of results) {
  if (!result.ok) failed++;
  // fixme: placeholder copy
  console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}${result.why ? `: ${result.why}` : ""}`);
  for (const key of ["first", "bad", "badFull", "settled", "before"]) if (result[key]) console.log(`  ${key}: ${result[key]}`);
}
fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(results.map(({ settledFrame, ...rest }) => rest), null, 1));
const leftover = fs.readdirSync(downloads);
fs.rmSync(home, { recursive: true, force: true });
// fixme: placeholder copy
console.log(`${results.length - failed}/${results.length} passed (${out})${leftover.length ? `, downloaded: ${leftover.join(", ")}` : ""}`);
process.exit(failed ? 1 : 0);
