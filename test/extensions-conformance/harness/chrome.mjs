// Chrome for Testing runner: headless, isolated profile, no background network.
import { spawn } from "node:child_process";
import { browserCdp } from "./cdp.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launchChrome({ binary, profile, log, headless = true, extraArgs = [], filter }) {
  const args = [`--user-data-dir=${profile}`, "--remote-debugging-port=0", "--enable-unsafe-extension-debugging",
    "--no-first-run", "--no-default-browser-check", "--window-size=1000,800", "--window-position=0,0",
    "--disable-background-networking", "--disable-component-update", "--disable-sync", "--use-mock-keychain", "--password-store=basic",
    ...(headless ? ["--headless=new"] : []), ...extraArgs, "about:blank"];
  const chrome = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
  let wsUrl = null;
  chrome.stderr.on("data", (d) => {
    const m = String(d).match(/DevTools listening on (ws:\S+)/);
    if (m) wsUrl = m[1];
  });
  for (let i = 0; i < 300 && !wsUrl; i++) await sleep(50);
  // fixme: placeholder copy
  if (!wsUrl) throw new Error(`Chrome never opened its DevTools port (${binary})`);
  const cdp = await browserCdp(wsUrl, log, filter);
  return {
    chrome, cdp,
    async kill() {
      cdp.close();
      chrome.kill("SIGTERM");
      await new Promise((r) => { if (chrome.exitCode !== null) r(); else chrome.on("exit", r); setTimeout(r, 5000); });
    },
  };
}
