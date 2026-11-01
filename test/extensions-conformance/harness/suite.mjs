// Runs the God extension self-test in one browser (Chrome for Testing or
// terminal-browser) and returns every check's result.
import fs from "node:fs";
import path from "node:path";
import { chromeDriver, tbDriver, sleep } from "./drivers.mjs";
import { startServer } from "./server.mjs";
import { interact } from "./interact.mjs";
import { startFakeTerminal } from "./terminal.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const EXT = path.join(ROOT, "extensions");
const ids = JSON.parse(fs.readFileSync(path.join(EXT, "ids.json"), "utf8"));
const DIRS = ["god", "peer", "noperm", "override-newtab", "override-history", "override-bookmarks"].map((d) => path.join(EXT, d));
// Every host except the local test site fails to resolve, so no check depends on the internet.
const OFFLINE = "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost";

// which: "chrome" | "tb". binary: the Chrome or Electron executable. notRun: [[idPattern, reason]] checks to skip.
export async function runSuite({ which, binary, out, only, video = false, notRun = [], log: print = console.error }) {
  const log = (...a) => print(`[${which} ${new Date().toISOString().slice(11, 19)}]`, ...a);
  fs.mkdirSync(out, { recursive: true });
  const downloads = fs.mkdtempSync(`/tmp/tbc-downloads-${which}-`);
  const hostScript = path.join(out, "native-host.sh");
  fs.writeFileSync(hostScript, `#!/bin/sh\nexec "${process.execPath}" "${path.join(ROOT, "native-host/host.mjs")}" "$@"\n`, { mode: 0o755 });
  const nativeHost = { name: "com.god.echo", manifest: { name: "com.god.echo", description: "God echo host", path: hostScript, type: "stdio", allowed_origins: [`chrome-extension://${ids.god}/`] } };

  const server = await startServer();
  const site = `http://localhost:${server.port}`;
  const config = { site, ids, browser: which, crashers: notRun.map(([pattern, reason]) => [pattern, reason, "not-run"]) };
  const base = `chrome-extension://${ids.god}/`;
  const SW = (t) => t.type === "service_worker" && t.url === `${base}sw.js`;

  const results = [];
  const surfaces = {};
  const extras = {};
  let d, terminal;
  try {
    if (which === "chrome") {
      d = await chromeDriver({
        binary,
        extensions: DIRS,
        nativeHost,
        prefs: { download: { default_directory: downloads, prompt_for_download: false } },
        extraArgs: ["--disable-features=NativeNotifications", "--force-dark-mode", OFFLINE],
        godId: ids.god,
      });
      extras.version = (await d.cdp.send("Browser.getVersion")).result.product.split("/")[1];
    } else {
      terminal = await startFakeTerminal(path.join(fs.mkdtempSync("/tmp/tbc-term-"), "terminal.sock"));
      d = await tbDriver({ electron: binary, chromiumArgs: [OFFLINE], out: path.join(out, "tb"), extensions: DIRS, nativeHost, startUrl: `${site}/page.html`, label: "god", recordVideo: false, env: { TERMINAL_BROWSER_TERMINAL_SOCKET: terminal.socket } });
      terminal.attach(d.tb);
      extras.version = await d.tb.mainEval(`
        const electron = req("electron");
        electron.app.setPath("downloads", ${JSON.stringify(downloads)});
        electron.Notification.isSupported = () => false;
        electron.nativeTheme.themeSource = "dark";
        electron.shell.openPath = async () => "";
        electron.shell.showItemInFolder = () => {};
        electron.shell.openExternal = async () => {};
        const speech = req(dist + "/extensions/speech.js");
        speech.useSpeechPlatform(new speech.SilentSpeech());
        return "electron " + process.versions.electron + ", chromium " + process.versions.chrome;`);
    }
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

    surfaces.sw = await d.evalIn(SW, "JSON.stringify(godSurface())").then(JSON.parse);
    const swResults = await d.evalIn(SW, "JSON.stringify(godAll())").then(JSON.parse);
    const seen = new Set(results.map((r) => `${r.ctx}|${r.id}`));
    for (const r of swResults) if (!seen.has(`${r.ctx}|${r.id}`)) results.push(r);
    extras.events = await d.evalIn(SW, "JSON.stringify(godEvents)").then(JSON.parse, () => ({}));
  } catch (error) {
    log("FATAL", error.stack);
    results.push({ id: "harness", ctx: "harness", ok: false, sig: `harness: ${error.message}`, note: error.stack });
  } finally {
    if (video && d?.tb) extras.video = await d.tb.stopRecording("god-selftest");
    if (d?.tb) {
      const daemonLog = fs.readFileSync(path.join(d.tb.out, "daemon.log"), "utf8");
      const crash = daemonLog.match(/Received signal \d+ \S+|FATAL:[^\n]+|Uncaught Exception[^\n]*|TypeError: Object has been destroyed/)?.[0];
      if (crash) extras.crash = crash;
      extras.daemonLog = path.join(d.tb.out, "daemon.log");
    }
    await d?.stop().catch(() => {});
    await terminal?.stop();
    await server.close();
    fs.rmSync(downloads, { recursive: true, force: true });
  }
  log(`${results.length} results`);
  return { browser: which, at: new Date().toISOString(), results, surfaces, extras };
}
