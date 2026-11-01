// Headless terminal-browser harness: runs the real daemon from a worktree and
// joins as the pixel owner host, so frames come back as images and mouse/key
// input goes in without any terminal or screen.
//
//   import { startBrowser } from "./tb.mjs";
//   const tb = await startBrowser({ url: "https://example.com", extensions: ["/path/to/unpacked"] });
//   await tb.shot("name"); await tb.click(x, y); await tb.type("hi"); await tb.key("enter");
//   const v = await tb.evalIn((t) => t.url.startsWith("chrome-extension://"), "1+1");
//   await tb.stop();
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import zlib from "node:zlib";

const require = createRequire(import.meta.url);
export const REPO = process.env.TB_REPO ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../..");
export const OUT = process.env.GOD_OUT ?? "/tmp/tb-god-ext";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function png({ bytes, width, height }, bg) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4, o = y * (width * 3 + 1) + 1 + x * 3;
      const a = bytes[i + 3] / 255;
      raw[o] = Math.round(bytes[i + 2] * a + bg[0] * (1 - a));
      raw[o + 1] = Math.round(bytes[i + 1] * a + bg[1] * (1 - a));
      raw[o + 2] = Math.round(bytes[i] * a + bg[2] * (1 - a));
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export async function startBrowser(options = {}) {
  const label = options.label ?? "tb";
  const out = options.out ?? path.join(OUT, "runs", `${label}-${Date.now()}`);
  const frames = path.join(out, "frames");
  fs.mkdirSync(frames, { recursive: true });
  const patched = process.env.TB_ELECTRON ?? path.join(OUT, "Electron.app/Contents/MacOS/Electron");
  const electron = options.electron ?? process.env.PIXEL_ELECTRON_BIN ??
    (fs.existsSync(patched) ? patched : path.join(REPO, "pixel/packages/pixel/electron/dist/Electron.app/Contents/MacOS/pixel"));
  const light = options.light ?? false;
  const bg = light ? [250, 250, 250] : [24, 24, 28];
  const fg = light ? [30, 30, 30] : [230, 230, 230];
  const cell = options.cell ?? { width: 10, height: 20 };
  const cols = options.cols ?? 140, rows = options.rows ?? 46;
  const width = cols * cell.width, height = rows * cell.height;

  const home = options.home ?? fs.mkdtempSync("/tmp/tbx-");
  const env = {
    XDG_STATE_HOME: path.join(home, "state"),
    XDG_RUNTIME_DIR: path.join(home, "run"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    TERMINAL_BROWSER_APPDATA: path.join(home, "appdata"),
  };
  for (const dir of Object.values(env)) fs.mkdirSync(dir, { recursive: true });
  if (options.config) {
    fs.mkdirSync(path.join(env.XDG_CONFIG_HOME, "terminal-browser"), { recursive: true });
    fs.writeFileSync(path.join(env.XDG_CONFIG_HOME, "terminal-browser", "settings.json"), JSON.stringify(options.config));
  }

  if (options.extensions?.length) {
    const seed = `
      const shared = require(${JSON.stringify(path.join(REPO, "shared/dist/index.js"))});
      for (const dir of JSON.parse(process.argv[1])) {
        const manifest = shared.readManifestFile(dir);
        const id = shared.extensionIdForDirectory(dir, manifest);
        shared.saveExtension({ id, path: dir, version: String(manifest.version), name: String(manifest.name), source: "unpacked",
          enabled: true, disabledReason: null, pinned: true, grantedPermissions: [], grantedOrigins: [], shortcuts: {},
          installedAt: Date.now(), updatedAt: Date.now(), lastUpdateCheck: null, userScriptsAllowed: true });
      }`;
    execFileSync(process.execPath, ["-e", seed, JSON.stringify(options.extensions.map((d) => path.resolve(d)))], { env: { ...process.env, ...env } });
  }

  const { OwnerServer } = require(path.join(REPO, "pixel/packages/pixel/dist/host/server.js"));
  const tty = `/dev/ttytbx${process.pid}`;
  const ownerSock = path.join(home, "owner.sock");
  const owner = new OwnerServer(ownerSock, () => cell);
  const instances = path.join(env.XDG_STATE_HOME, "pixel", "instances");
  fs.mkdirSync(instances, { recursive: true });
  fs.writeFileSync(path.join(instances, tty.replace(/[^\w-]/g, "_") + ".json"), JSON.stringify({
    tty, pid: process.pid, socket: ownerSock, protocol: 1, name: "harness", title: "harness", cwd: home, startedAt: Date.now(),
  }));

  let latest = null;
  let recording = false;
  let lastSaved = 0;
  const saved = [];
  let guest = null;
  const frameWaiters = new Set();
  const joined = new Promise((resolve) => {
    owner.onJoin = (g) => {
      guest = g;
      g.onFrame = ({ path: file, width: w, height: h, ack }) => {
        let bytes;
        try {
          bytes = fs.readFileSync(file);
        } catch {
          ack();
          return;
        }
        ack();
        latest = { bytes, width: w, height: h, at: Date.now() };
        for (const waiter of [...frameWaiters]) waiter();
        const now = Date.now();
        if (recording && now - lastSaved >= 1000 / (options.fps ?? 30)) {
          lastSaved = now;
          const name = path.join(frames, `f${String(saved.length).padStart(6, "0")}.png`);
          fs.writeFileSync(name, png(latest, bg));
          saved.push({ name, at: now });
        }
      };
      g.send({ type: "init", cols, rows, width, height, cell: [cell.width, cell.height], colors: { foreground: [...fg, 255], background: [...bg, 255], palette: [] }, focused: true });
      resolve(g);
    };
  });

  const daemonEnv = { ...process.env, ...env, NODE_ENV: "production", ...(options.env ?? {}) };
  delete daemonEnv.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(daemonEnv)) if (k.startsWith("PIXEL_") && k !== "PIXEL_ELECTRON_BIN") delete daemonEnv[k];
  const daemonLog = fs.openSync(path.join(out, "daemon.log"), "w");
  const inspectPort = options.inspectPort ?? (20000 + Math.floor(Math.random() * 20000));
  const daemon = spawn(electron, [`--inspect=127.0.0.1:${inspectPort}`, path.join(REPO, "browser/dist/main.js"), "--daemon"], { cwd: path.join(REPO, "browser"), env: daemonEnv, stdio: ["ignore", daemonLog, daemonLog] });
  let mainSession = null;
  // Evaluates in the daemon's main process; `svc` is the extension service.
  const mainEval = async (expression) => {
    if (!mainSession) {
      const list = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json();
      const ws = new WebSocket(list[0].webSocketDebuggerUrl);
      await new Promise((r, j) => { ws.addEventListener("open", r, { once: true }); ws.addEventListener("error", j, { once: true }); });
      let nextId = 1;
      const pending = new Map();
      ws.addEventListener("message", (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      });
      mainSession = { ws, send: (method, params = {}) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); }) };
    }
    const wrapped = `(async () => { const req = process.mainModule.require; const dist = ${JSON.stringify(path.join(REPO, "browser/dist"))}; const svc = req(dist + "/extensions/service.js").extensionService(); ${expression} })()`;
    const res = await mainSession.send("Runtime.evaluate", { expression: wrapped, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true });
    if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails));
    return res.result?.result?.value;
  };
  let stopped = false;
  const kill = () => {
    if (stopped) return;
    stopped = true;
    try { daemon.kill("SIGTERM"); } catch {}
    try { owner.stop(); } catch {}
  };
  process.on("exit", kill);

  const findDaemonSock = () => {
    for (const d of fs.readdirSync(env.XDG_RUNTIME_DIR)) {
      const p = path.join(env.XDG_RUNTIME_DIR, d, "daemon.sock");
      if (d.startsWith("terminal-browser") && fs.existsSync(p)) return p;
    }
    return null;
  };
  let daemonSock = null;
  for (let i = 0; i < 150 && !(daemonSock = findDaemonSock()); i++) await sleep(200);
  if (!daemonSock) { kill(); throw new Error(`daemon never listened, see ${out}/daemon.log`); }

  const conn = net.connect(daemonSock);
  let reply = "";
  const opened = new Promise((resolve) => conn.on("data", (d) => {
    reply += d;
    if (reply.includes("\n")) resolve(JSON.parse(reply.split("\n")[0]));
  }));
  const argv = options.url ? [options.url] : [];
  conn.write(JSON.stringify({ cmd: "open", tty, argv, env: { ...process.env, ...env, TERM: "xterm-kitty", ...(options.env ?? {}) }, cwd: options.cwd ?? home }) + "\n");
  const openReply = await opened;
  if (!openReply.ok) { kill(); throw new Error(`open failed: ${JSON.stringify(openReply)}`); }
  await joined;

  const instanceSock = path.join(path.dirname(daemonSock), "instances", `${openReply.session}.sock`);
  const control = (cmd, extra = {}) => new Promise((resolve, reject) => {
    const c = net.connect(instanceSock);
    let buf = "";
    c.on("data", (d) => { buf += d; });
    c.on("end", () => {
      try {
        const res = JSON.parse(buf.split("\n")[0]);
        if (res.ok) resolve(res.data); else reject(new Error(res.error));
      } catch (e) { reject(e); }
    });
    c.on("error", reject);
    c.write(JSON.stringify({ id: "1", cmd, ...extra }) + "\n");
  });
  const daemonCommand = (message) => new Promise((resolve, reject) => {
    const c = net.connect(daemonSock);
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      if (buf.includes("\n")) { c.end(); resolve(JSON.parse(buf.split("\n")[0])); }
    });
    c.on("error", reject);
    c.write(JSON.stringify(message) + "\n");
  });

  let state = null;
  for (let i = 0; i < 100; i++) {
    state = await control("state").catch(() => null);
    if (state?.cdpPort) break;
    await sleep(200);
  }
  const cdpPort = state?.cdpPort;

  const targets = async () => (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json());
  const sockets = new Map();
  const connect = async (target) => {
    if (sockets.has(target.id)) return sockets.get(target.id);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r, { once: true }); ws.addEventListener("error", j, { once: true }); });
    let nextId = 1;
    const pending = new Map();
    ws.addEventListener("message", (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    });
    const session = {
      send: (method, params = {}) => new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      }),
      close: () => ws.close(),
    };
    sockets.set(target.id, session);
    return session;
  };
  const waitTarget = async (predicate, timeout = 15000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const found = (await targets().catch(() => [])).find(predicate);
      if (found) return found;
      await sleep(200);
    }
    throw new Error("target not found");
  };
  const evalIn = async (predicate, expression, timeout) => {
    const target = await waitTarget(typeof predicate === "string" ? (t) => t.url.startsWith(predicate) : predicate, timeout);
    const session = await connect(target);
    const res = await session.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails));
    return res.result?.result?.value;
  };

  const mods = { shift: false, alt: false, ctrl: false, super: false };
  const mouse = (kind, x, y, button = "left") => guest.send({ type: "mouse", kind, button: kind === "move" ? "none" : button, mods, x: Math.round(x), y: Math.round(y) });
  const api = {
    out, home, env, cdpPort, daemonSock, session: openReply.session, width, height, cell,
    control, daemonCommand, targets, waitTarget, evalIn, connect, mainEval,
    frame: () => latest,
    async nextFrame(timeout = 3000) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => { frameWaiters.delete(done); resolve(); }, timeout);
        const done = () => { clearTimeout(timer); frameWaiters.delete(done); resolve(); };
        frameWaiters.add(done);
      });
      return latest;
    },
    async shot(name, delay = 300) {
      await sleep(delay);
      if (!latest) return null;
      const file = path.join(out, `${name}.png`);
      fs.writeFileSync(file, png(latest, bg));
      return file;
    },
    pixel(x, y) {
      const i = (Math.round(y) * latest.width + Math.round(x)) * 4;
      return [latest.bytes[i + 2], latest.bytes[i + 1], latest.bytes[i], latest.bytes[i + 3]];
    },
    move: async (x, y) => { mouse("move", x, y); await sleep(40); },
    async click(x, y, button = "left") { mouse("move", x, y); await sleep(50); mouse("down", x, y, button); await sleep(60); mouse("up", x, y, button); await sleep(200); },
    async wheel(x, y, deltaY = 40, n = 6) { mouse("move", x, y); for (let i = 0; i < n; i++) { guest.send({ type: "wheel", x, y, deltaX: 0, deltaY, mods }); await sleep(30); } await sleep(200); },
    async key(k, opts = {}) {
      const m = { ...mods, ...(opts.mods ?? {}) };
      guest.send({ type: "key", key: k, kind: "press", ...(opts.text ? { text: opts.text } : {}), mods: m });
      await sleep(25);
      guest.send({ type: "key", key: k, kind: "release", mods: m });
      await sleep(35);
    },
    async type(text, perKey = 0) { for (const ch of text) { await api.key(ch, { text: ch }); if (perKey) await sleep(perKey); } await sleep(100); },
    // Finds where a target's CSS (0,0) sits on screen by flashing a marker there.
    async locate(predicate) {
      const mark = "(() => { const d = document.createElement('div'); d.id = '__tbmark'; d.style.cssText = 'position:fixed;left:0;top:0;width:6px;height:6px;background:#ff00ff;z-index:2147483647;pointer-events:none'; document.documentElement.appendChild(d); return devicePixelRatio; })()";
      const wasRecording = recording;
      recording = false;
      const dpr = await api.evalIn(predicate, mark);
      let found = null;
      for (let attempt = 0; attempt < 15 && !found; attempt++) {
        await api.nextFrame(500);
        await sleep(80);
        const f = latest;
        for (let y = 0; y < f.height && !found; y++) for (let x = 0; x < f.width; x++) {
          const i = (y * f.width + x) * 4;
          if (f.bytes[i + 2] > 240 && f.bytes[i + 1] < 20 && f.bytes[i] > 240) { found = { x, y }; break; }
        }
      }
      await api.evalIn(predicate, "document.getElementById('__tbmark')?.remove()");
      await api.nextFrame(500);
      await sleep(80);
      recording = wasRecording;
      if (!found) throw new Error("marker not found");
      return { ...found, scale: 1 };
    },
    async clickSelector(predicate, selector, origin) {
      const o = origin ?? (await api.locate(predicate));
      const r = await api.evalIn(predicate, `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({block:'nearest'}); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      if (!r) throw new Error(`no element ${selector}`);
      await api.click(o.x + r.x * o.scale, o.y + r.y * o.scale);
      return o;
    },
    startRecording() { recording = true; },
    async stopRecording(name = "video", fps = options.fps ?? 30) {
      recording = false;
      if (saved.length === 0) return null;
      const list = path.join(out, `${name}.ffconcat`);
      const lines = ["ffconcat version 1.0"];
      saved.forEach((f, i) => {
        const next = saved[i + 1]?.at ?? f.at + 1000 / fps;
        lines.push(`file '${f.name}'`, `duration ${Math.max(1 / fps, (next - f.at) / 1000).toFixed(4)}`);
      });
      lines.push(`file '${saved[saved.length - 1].name}'`);
      fs.writeFileSync(list, lines.join("\n"));
      const mp4 = path.join(out, `${name}.mp4`);
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", `fps=${fps},scale=trunc(iw/2)*2:trunc(ih/2)*2`, "-pix_fmt", "yuv420p", "-c:v", "libx264", "-crf", "18", mp4]);
      saved.length = 0;
      return mp4;
    },
    async stop() {
      for (const s of sockets.values()) try { s.close(); } catch {}
      try { mainSession?.ws.close(); } catch {}
      try { conn.write(JSON.stringify({ cmd: "close" }) + "\n"); } catch {}
      await sleep(600);
      kill();
      await sleep(300);
    },
  };
  return api;
}
