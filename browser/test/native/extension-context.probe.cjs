// What extensions see of the browser (patches 0031, 0032, 0034, 0036): @@ui_locale is the app locale ("en_US"), content
// scripts get chrome.extension.inIncognitoContext, the app's own standard schemes are restricted like chrome://, and
// chrome.debugger.getTargets() lists workers too, and DevTools windows as "other" rather than tabs.
const { BrowserWindow, protocol } = require("electron");

protocol.registerSchemesAsPrivileged([{ scheme: "probe-ui", privileges: { standard: true, secure: true } }]);

require("./harness.cjs").run("extension-context", async ({ ses, port, waitReport, writeExtension, eq, check }) => {
  ses.protocol.handle("probe-ui", () => new Response("<!doctype html><title>ui</title>", { headers: { "content-type": "text/html" } }));
  const dir = writeExtension("context", port, {
    "manifest.json": {
      manifest_version: 3,
      name: "context",
      version: "1",
      default_locale: "en",
      permissions: ["scripting"],
      host_permissions: ["<all_urls>"],
      background: { service_worker: "sw.js" },
      content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["report.js", "cs.js"] }],
    },
    "_locales/en/messages.json": { name: { message: "context" } },
    "cs.js": `report("cs", { locale: chrome.i18n.getMessage("@@ui_locale"), incognito: chrome.extension?.inIncognitoContext ?? "missing" });`,
    "sw.js": `importScripts("report.js");
      report("sw", chrome.i18n.getMessage("@@ui_locale"));
      chrome.runtime.onMessage.addListener((tabId) => {
        chrome.scripting.executeScript({ target: { tabId }, func: () => 1 }).then(
          () => report("ui", "allowed"),
          (e) => report("ui", e.message),
        );
      });`,
    "page.html": `<script src="page.js"></script>`,
    "page.js": `chrome.runtime.sendMessage(Number(location.hash.slice(1)));`,
  });
  const extension = await ses.extensions.loadExtension(dir);
  eq(await waitReport("sw"), "en_US", "@@ui_locale in the service worker");

  const page = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await page.loadURL(`http://127.0.0.1:${port}/page`);
  eq(await waitReport("cs"), { locale: "en_US", incognito: false }, "content script");

  const ui = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await ui.loadURL("probe-ui://settings/");
  const sender = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await sender.loadURL(`${extension.url}page.html#${ui.webContents.id}`);
  eq(await waitReport("ui"), "Cannot access a chrome:// URL", "scripting on the app's own scheme");

  const devtools = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await devtools.loadURL("devtools://devtools/bundled/devtools_app.html").catch(() => {});
  const targets = ses.extensions.getDebuggerTargets();
  const types = [...new Set(targets.map((t) => t.type))].sort();
  check(types.includes("page") && types.includes("worker"), `debugger targets lack a page or worker: ${JSON.stringify(types)}`);
  eq(targets.find((t) => t.tabId === page.webContents.id)?.type, "page", "tab target");
  check(targets.some((t) => t.type === "worker" && t.url === `${extension.url}sw.js`), "the extension's service worker target");
  eq(targets.find((t) => t.url.startsWith("devtools://"))?.type, "other", "a DevTools window target");
  check(!targets.some((t) => t.url.startsWith("devtools://") && t.tabId !== undefined), "a DevTools window has no tab id");
});
