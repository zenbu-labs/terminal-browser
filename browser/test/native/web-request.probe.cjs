// webRequest (patches 0025, 0026): requests from a page carry its webContents id as tabId, requests from a WebContents
// marked as a popup carry -1 and its messages have no sender.tab, and onAuthRequired credentials answer the challenge.
const { BrowserWindow } = require("electron");

require("./harness.cjs").run("web-request", async ({ ses, port, waitReport, writeExtension, eq, sleep }) => {
  const dir = writeExtension("wr", port, {
    "manifest.json": {
      manifest_version: 3,
      name: "wr",
      version: "1",
      permissions: ["webRequest", "webRequestAuthProvider"],
      host_permissions: ["http://127.0.0.1/*"],
      background: { service_worker: "sw.js" },
    },
    "sw.js": `importScripts("report.js");
      chrome.webRequest.onBeforeRequest.addListener((d) => {
        const which = new URL(d.url).searchParams.get("from");
        if (which) report("tab-" + which, d.tabId);
      }, { urls: ["http://127.0.0.1/*"] });
      chrome.webRequest.onAuthRequired.addListener((d, callback) => callback({ authCredentials: { username: "probe", password: "pw" } }),
        { urls: ["http://127.0.0.1/*"] }, ["asyncBlocking"]);
      chrome.runtime.onMessage.addListener((m, sender) => { report("sender-" + m, sender.tab ? sender.tab.id : null); });
      report("ready", true);`,
    "page.html": `<script src="report.js"></script><script src="page.js"></script>`,
    "page.js": `chrome.runtime.sendMessage(location.hash.slice(1));`,
  });
  const extension = await ses.extensions.loadExtension(dir);
  await waitReport("ready");

  const tab = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await tab.loadURL(`http://127.0.0.1:${port}/page`);
  await tab.webContents.executeJavaScript(`fetch("/x?from=tab").then(() => 0)`);
  eq(await waitReport("tab-tab"), tab.webContents.id, "tabId of a page request");

  const auth = await tab.webContents.executeJavaScript(`fetch("/auth").then((r) => r.status + " " + r.statusText)`);
  eq(auth.split(" ")[0], "200", "onAuthRequired credentials used");

  const popup = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  eq(ses.extensions.setViewType(popup.webContents, "popup"), true, "setViewType");
  await popup.loadURL(`http://127.0.0.1:${port}/page`);
  await popup.webContents.executeJavaScript(`fetch("/x?from=popup").then(() => 0)`);
  eq(await waitReport("tab-popup"), -1, "tabId of a popup request");

  const extTab = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await extTab.loadURL(`${extension.url}page.html#tab`);
  eq(await waitReport("sender-tab"), extTab.webContents.id, "sender.tab of an extension page in a tab");
  const extPopup = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  ses.extensions.setViewType(extPopup.webContents, "popup");
  await extPopup.loadURL(`${extension.url}page.html#popup`);
  eq(await waitReport("sender-popup"), null, "sender.tab of an extension popup");
  await sleep(100);
});
