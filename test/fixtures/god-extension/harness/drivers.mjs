// One interface over Chrome for Testing (the reference) and terminal-browser,
// so the same run script drives both: start, evaluate in any extension target,
// open tabs, stop.
import fs from "node:fs";
import path from "node:path";
import { launchChrome, sleep } from "./chrome.mjs";
import { startBrowser, OUT } from "./tb.mjs";

export { sleep };

function targetMatcher(match) {
  if (typeof match === "function") return match;
  return (t) => t.url.startsWith(match) || t.url.includes(match);
}

function nativeHostManifest(hostDir, nativeHost) {
  if (!nativeHost) return;
  fs.mkdirSync(hostDir, { recursive: true });
  fs.writeFileSync(path.join(hostDir, `${nativeHost.name}.json`), JSON.stringify(nativeHost.manifest, null, 2));
}

export async function chromeDriver({ extensions, nativeHost, log, headless = true, extraArgs = [], prefs, godId = "" }) {
  const profile = fs.mkdtempSync(path.join(OUT, "profiles", "chrome-"));
  if (prefs) {
    fs.mkdirSync(path.join(profile, "Default"), { recursive: true });
    fs.writeFileSync(path.join(profile, "Default", "Preferences"), JSON.stringify(prefs));
  }
  nativeHostManifest(path.join(profile, "NativeMessagingHosts"), nativeHost);
  const c = await launchChrome({
    profile,
    headless,
    log: log ?? (() => {}),
    filter: () => false,
    extraArgs: ["--disable-features=DisableLoadExtensionCommandLineSwitch", "--auto-open-devtools-for-tabs", ...extraArgs],
  });
  const ids = [];
  for (const dir of extensions) {
    const res = await c.cdp.send("Extensions.loadUnpacked", { path: dir });
    if (res.error) throw new Error(`loadUnpacked ${dir}: ${res.error.message}`);
    ids.push(res.result.id);
  }
  const attached = new Map();
  const targets = async () => (await c.cdp.send("Target.getTargets")).result.targetInfos.map((t) => ({ ...t, id: t.targetId }));
  const session = async (targetId) => {
    if (!attached.has(targetId)) {
      const res = await c.cdp.send("Target.attachToTarget", { targetId, flatten: true });
      if (res.error) throw new Error(res.error.message);
      attached.set(targetId, res.result.sessionId);
    }
    return attached.get(targetId);
  };
  const waitTarget = async (match, timeout = 15000) => {
    const pred = targetMatcher(match);
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const found = (await targets()).find(pred);
      if (found) return found;
      await sleep(150);
    }
    throw new Error(`target not found: ${match}`);
  };
  const evalIn = async (match, expression, timeout) => {
    const target = await waitTarget(match, timeout);
    const sid = await session(target.targetId);
    const res = await c.cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sid);
    if (res.error) throw new Error(res.error.message);
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text);
    return res.result?.result?.value;
  };
  const send = async (match, method, params = {}) => {
    const target = await waitTarget(match);
    const res = await c.cdp.send(method, params, await session(target.targetId));
    if (res.error) throw new Error(res.error.message);
    return res.result;
  };
  return {
    name: "chrome",
    send,
    ids,
    profile,
    cdp: c.cdp,
    targets,
    waitTarget,
    evalIn,
    // Opened from the God worker so every tab shares one window, like a real
    // profile; headless CDP targets would each get their own window.
    async openTab(url) {
      const sw = (await targets()).find((t) => t.type === "service_worker" && t.url.endsWith("/sw.js") && t.url.includes(godId));
      if (!sw) return (await c.cdp.send("Target.createTarget", { url })).result.targetId;
      const res = await c.cdp.send("Runtime.evaluate", { expression: `chrome.tabs.create({ url: ${JSON.stringify(url)} }).then((t) => t.id)`, awaitPromise: true, returnByValue: true }, await session(sw.targetId));
      return res.result?.result?.value;
    },
    // Chrome's "Allow User Scripts" toggle, flipped from chrome://extensions.
    async allowUserScripts(id) {
      const targetId = (await c.cdp.send("Target.createTarget", { url: "chrome://extensions" })).result.targetId;
      const sid = await session(targetId);
      await sleep(1000);
      const res = await c.cdp.send("Runtime.evaluate", { expression: `chrome.developerPrivate.updateExtensionConfiguration({ extensionId: ${JSON.stringify(id)}, userScriptsAccess: true }).then(() => "ok", (e) => e.message)`, awaitPromise: true, returnByValue: true }, sid);
      await c.cdp.send("Target.closeTarget", { targetId });
      return res.result?.result?.value;
    },
    async stop() {
      await c.kill();
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}

export async function tbDriver({ extensions, nativeHost, label = "god", startUrl, recordVideo = false, ...rest }) {
  const home = fs.mkdtempSync(path.join(OUT, "profiles", "tb-"));
  const tb = await startBrowser({ label, home, url: startUrl, extensions, ...rest });
  if (nativeHost) {
    const userData = await tb.mainEval("return process.mainModule.require('electron').app.getPath('userData')");
    nativeHostManifest(path.join(userData, "NativeMessagingHosts"), nativeHost);
  }
  if (recordVideo) tb.startRecording();
  const send = async (match, method, params = {}) => {
    const target = await tb.waitTarget(targetMatcher(match));
    const res = await (await tb.connect(target)).send(method, params);
    if (res.error) throw new Error(res.error.message);
    return res.result;
  };
  return {
    name: "tb",
    send,
    tb,
    home,
    targets: tb.targets,
    waitTarget: (match, timeout) => tb.waitTarget(targetMatcher(match), timeout),
    evalIn: (match, expression, timeout) => tb.evalIn(targetMatcher(match), expression, timeout),
    async openTab(url) {
      return tb.control("open-tab", { url }).catch(() => null);
    },
    async stop() {
      await tb.stop();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

// Clicks an element with a real input event (so the page gets a user gesture).
export async function clickElement(d, match, selector) {
  const box = await d.evalIn(match, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`).then(JSON.parse);
  for (const type of ["mousePressed", "mouseReleased"]) await d.send(match, "Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
}
