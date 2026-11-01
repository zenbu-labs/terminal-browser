// Chrome for Testing runner: headless, isolated profile, Developer mode on,
// loads an unpacked extension via CDP while auto-attached, so every log from
// the worker's first instruction is captured; then reads Chrome's own
// ErrorConsole (developerPrivate.getExtensionInfo().runtimeErrors).
import { spawn } from "node:child_process";
import fs from "node:fs";
import { browserCdp } from "./cdp.mjs";

export const CHROME = process.env.CFT_CHROME ?? "/tmp/tb-extensions/cft/chrome/mac_arm-156.0.8078.80/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launchChrome({ profile, log, loadExtension, headless = true, extraArgs = [], filter }) {
  const port = 9400 + Math.floor(Math.random() * 400);
  const args = [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--enable-unsafe-extension-debugging",
    "--no-first-run", "--no-default-browser-check", "--window-size=1000,800", "--window-position=0,0",
    ...(headless ? ["--headless=new"] : []), ...(loadExtension ? [`--load-extension=${loadExtension}`] : []), ...extraArgs, "about:blank"];
  const chrome = spawn(CHROME, args, { stdio: ["ignore", "ignore", "pipe"] });
  let wsUrl = null;
  chrome.stderr.on("data", (d) => {
    const m = String(d).match(/DevTools listening on (ws:\S+)/);
    if (m) wsUrl = m[1];
  });
  for (let i = 0; i < 100 && !wsUrl; i++) await sleep(50);
  const cdp = await browserCdp(wsUrl, log, filter);
  const pageEval = async (url, expression) => {
    const { result: { targetId } } = await cdp.send("Target.createTarget", { url });
    const { result: { sessionId } } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await sleep(1500);
    const res = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    return { value: res.result?.result?.value ?? res.result?.exceptionDetails, targetId, sessionId };
  };
  return {
    chrome, cdp, port, pageEval,
    async kill() {
      cdp.close();
      chrome.kill("SIGTERM");
      await new Promise((r) => { if (chrome.exitCode !== null) r(); else chrome.on("exit", r); setTimeout(r, 5000); });
    },
  };
}

export const ENABLE_DEV_MODE = "new Promise(r => chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode: true}, () => r('dev mode on')))";
export const errorsOf = (id) => `new Promise(r => chrome.developerPrivate.getExtensionInfo(${JSON.stringify(id)}, (i) => r(JSON.stringify({ state: i?.state, runtimeErrors: (i?.runtimeErrors ?? []).map(e => ({ level: e.severity, msg: e.message, src: e.source, ctx: e.contextUrl, count: e.occurrences })), manifestErrors: (i?.manifestErrors ?? []).map(e => e.message) }, null, 1))))`;
