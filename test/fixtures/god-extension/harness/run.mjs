// Runs the God extension self-test in one browser and writes
// <out>/results-<browser>.json.
//   node run.mjs chrome
//   node run.mjs tb [--video]
import fs from "node:fs";
import path from "node:path";
import { chromeDriver, tbDriver, sleep } from "./drivers.mjs";
import { startServer } from "./server.mjs";
import { OUT } from "./tb.mjs";
import { interact } from "./interact.mjs";

const which = process.argv[2];
const video = process.argv.includes("--video");
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const EXT = path.join(ROOT, "extensions");
const ids = JSON.parse(fs.readFileSync(path.join(EXT, "ids.json"), "utf8"));
const DIRS = ["god", "peer", "noperm", "override-newtab", "override-history", "override-bookmarks"].map((d) => path.join(EXT, d));
fs.mkdirSync(path.join(OUT, "profiles"), { recursive: true });
const log = (...a) => console.error(`[${which} ${new Date().toISOString().slice(11, 19)}]`, ...a);

const downloads = fs.mkdtempSync(path.join(OUT, "profiles", `downloads-${which}-`));
const hostScript = path.join(OUT, "native-host.sh");
fs.writeFileSync(hostScript, `#!/bin/sh\nexec "${process.execPath}" "${path.join(ROOT, "native-host/host.mjs")}" "$@"\n`, { mode: 0o755 });
const nativeHost = { name: "com.god.echo", manifest: { name: "com.god.echo", description: "God echo host", path: hostScript, type: "stdio", allowed_origins: [`chrome-extension://${ids.god}/`] } };

const server = await startServer();
const site = `http://localhost:${server.port}`;
// Calls that take the whole browser down; run once each by repro.mjs instead.
const CRASHERS = { tb: [["^system\\.storage\\.(getInfo|getAvailableCapacity|ejectDevice)$", "SEGV in StorageMonitor (browser process dies), see repro.mjs"], ["^windows\\.create#popup$", "intermittent: main process TypeError 'Object has been destroyed' in pixel PageHost.updateNavigation, browser exits (1 of 5 attempts)"], ["^downloads\\.open#no-gesture$", "opens the file with the system default app without a user gesture (seen in an earlier run); not run again to keep the host clean", "fails"]], chrome: [] };
const config = { site, ids, browser: which, crashers: process.env.GOD_NO_SKIP ? [] : CRASHERS[which] };
const base = `chrome-extension://${ids.god}/`;
const SW = (t) => t.type === "service_worker" && t.url === `${base}sw.js`;

let d;
if (which === "chrome") {
  d = await chromeDriver({
    extensions: DIRS,
    nativeHost,
    prefs: { download: { default_directory: downloads, prompt_for_download: false } },
    extraArgs: ["--disable-features=NativeNotifications"],
    godId: ids.god,
  });
} else {
  d = await tbDriver({ extensions: DIRS, nativeHost, startUrl: `${site}/page.html`, label: "god", recordVideo: false });
  await d.tb.mainEval(`
    const electron = req("electron");
    electron.app.setPath("downloads", ${JSON.stringify(downloads)});
    electron.Notification.isSupported = () => false;
    return "isolated";`);
}

const results = [];
const surfaces = {};
const extras = {};
try {
  await d.evalIn(SW, "typeof god", 30000);
  if (which === "chrome") {
    await d.allowUserScripts(ids.god);
    await d.openTab(`${site}/page.html`);
  }
  await sleep(1500);
  if (video) {
    await d.evalIn(SW, "chrome.windows.create({ url: 'results.html', type: 'popup', width: 620, height: 820, left: 760, top: 40, focused: false }).then(() => 'ok')");
    await sleep(1500);
    d.tb?.startRecording();
  }

  log("service worker tests");
  await d.evalIn(SW, `(god.run("sw", ${JSON.stringify(config)}, ${only ? `{ only: new RegExp(${JSON.stringify(only)}) }` : "{}"}), "started")`);
  let last = -1, lost = 0;
  for (;;) {
    await sleep(1000);
    const state = await d.evalIn(SW, "JSON.stringify({ done: god.done, n: god.results.length, last: god.results.at(-1)?.id })", 5000).then(JSON.parse, (e) => log("poll error", e.message.slice(0, 300)));
    if (!state) {
      if (++lost >= 6) throw new Error(`God service worker gone after test ${last}`);
      continue;
    }
    lost = 0;
    if (state.n !== last) log(`  ${state.n} ${state.last ?? ""}`);
    last = state.n;
    if (state.done) break;
  }

  const runPage = async (ctx, url, read) => {
    log(`${ctx} tests`);
    if (url) await d.openTab(url);
    try {
      const match = typeof read === "function" ? read : (t) => t.url.startsWith(read);
      for (let i = 0; i < 120; i++) {
        await sleep(500);
        const got = await d.evalIn(match, "globalThis.god?.done ? JSON.stringify(god.results) : null", 3000).catch(() => null);
        if (got) return JSON.parse(got);
      }
      return [{ id: `context.${ctx}`, ctx, ok: false, sig: "context never finished", note: "context never finished" }];
    } catch (error) {
      return [{ id: `context.${ctx}`, ctx, ok: false, sig: `context missing: ${error.message}`, note: error.message }];
    }
  };

  const page = await runPage("page", `${base}page.html`, `${base}page.html`);
  results.push(...page);
  surfaces.page = await d.evalIn(`${base}page.html`, "JSON.stringify(SURFACE)").then(JSON.parse, () => ({}));
  results.push(...(await runPage("options", `${base}options.html`, `${base}options.html`)));

  log("content script tests");
  await d.openTab(`${site}/page.html?cs-tests=1`);
  let cs = null;
  for (let i = 0; i < 60 && !cs; i++) {
    await sleep(500);
    cs = await d.evalIn((t) => t.type === "page" && t.url.includes("cs-tests=1"), "document.documentElement.dataset.godCsResults || null").catch(() => null);
  }
  results.push(...(cs ? JSON.parse(cs) : [{ id: "context.cs", ctx: "cs", ok: false, sig: "content script tests never finished", note: "" }]));
  surfaces.cs = await d.evalIn((t) => t.type === "page" && t.url.includes("cs-tests=1"), "document.documentElement.dataset.godCs || '{}'").then(JSON.parse, () => ({}));
  extras.mainWorld = await d.evalIn((t) => t.type === "page" && t.url.includes("cs-tests=1"), "document.documentElement.dataset.godMain || 'missing'").catch((e) => `error ${e.message}`);

  log("gating tests");
  // Sent as a message so a sleeping worker wakes up for it.
  const gating = await d.evalIn(SW, `chrome.runtime.sendMessage(${JSON.stringify(ids.noperm)}, { kind: "run-gating", config: ${JSON.stringify(config)} }).then(JSON.stringify)`, 20000).then(JSON.parse, (e) => [{ id: "context.noperm", ctx: "noperm", ok: false, sig: `noperm worker unreachable: ${e.message}`, note: e.message }]);
  results.push(...gating);

  log("interactive checks");
  const interactive = await interact(d, { which, site, ids, base, sleep, log }).catch((e) => [{ id: "interactive", ctx: "harness", ok: false, sig: `harness error: ${e.message}`, note: e.stack }]);
  results.push(...interactive);

  surfaces.sw = await d.evalIn(SW, "JSON.stringify(SURFACE)").then(JSON.parse);
  const swResults = await d.evalIn(SW, "JSON.stringify(godAll())").then(JSON.parse);
  const seen = new Set(results.map((r) => `${r.ctx}|${r.id}`));
  for (const r of swResults) if (!seen.has(`${r.ctx}|${r.id}`)) results.push(r);
  extras.events = await d.evalIn(SW, "JSON.stringify(godEvents)").then(JSON.parse, () => ({}));
} catch (error) {
  log("FATAL", error.stack);
  results.push({ id: "harness", ctx: "harness", ok: false, sig: `harness: ${error.message}`, note: error.stack });
} finally {
  if (video && d.tb) extras.video = await d.tb.stopRecording("god-selftest");
  if (d.tb) {
    const daemonLog = fs.readFileSync(path.join(d.tb.out, "daemon.log"), "utf8");
    const crash = daemonLog.match(/Received signal \d+ \S+|FATAL:[^\n]+/)?.[0];
    if (crash) extras.crash = `${crash} (daemon log: ${path.join(d.tb.out, "daemon.log")})`;
  }
  const out = path.join(OUT, `results-${which}.json`);
  fs.writeFileSync(out, JSON.stringify({ browser: which, at: new Date().toISOString(), results, surfaces, extras, hits: server.hits.length }, null, 1));
  log(`wrote ${out} (${results.length} results)`);
  if (d.tb) extras.daemonLog = path.join(d.tb.out, "daemon.log");
  await d.stop().catch(() => {});
  await server.close();
  fs.rmSync(downloads, { recursive: true, force: true });
}
