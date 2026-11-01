// Session.extensions.grantActiveTab / revokeActiveTab (patch 0010) drive Chromium's ActiveTabPermissionGranter. The
// grant lasts while the tab's main frame stays on the same origin (same-document and same-origin navigations) and is
// gone after a cross-origin one, which is the rule terminal-browser's own copy of the grant follows.
const { BrowserWindow } = require("electron");

require("./harness.cjs").run("active-tab", async ({ ses, port, waitReport, writeExtension, eq }) => {
  const extension = await ses.extensions.loadExtension(
    writeExtension("active-tab", port, {
      "manifest.json": { manifest_version: 3, name: "active-tab", version: "1", permissions: ["activeTab", "scripting"], background: { service_worker: "sw.js" } },
      "sw.js": `importScripts("report.js");
        chrome.runtime.onMessage.addListener(([key, tabId]) => {
          chrome.scripting.executeScript({ target: { tabId }, func: () => 1 }).then(() => report(key, "allowed"), () => report(key, "denied"));
        });`,
      "ask.html": `<script src="ask.js"></script>`,
      "ask.js": `chrome.runtime.sendMessage(JSON.parse(decodeURIComponent(location.search.slice(1))));`,
    }),
  );
  const tab = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  const contents = tab.webContents;
  const asker = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  let asked = 0;
  const canScript = async () => {
    const key = `ask${asked++}`;
    await asker.loadURL(`${extension.url}ask.html?${encodeURIComponent(JSON.stringify([key, contents.id]))}`);
    return waitReport(key, 10000);
  };
  const site = `http://127.0.0.1:${port}`;

  await contents.loadURL(`${site}/page`);
  eq(await canScript(), "denied", "before the grant");
  eq(ses.extensions.grantActiveTab(extension.id, contents), true, "grant");
  eq(await canScript(), "allowed", "after the grant");
  await contents.executeJavaScript(`location.hash = "x"; 1`);
  eq(await canScript(), "allowed", "after a same-document navigation");
  await contents.loadURL(`${site}/page?next`);
  eq(await canScript(), "allowed", "after a same-origin navigation");
  await contents.loadURL(`http://localhost:${port}/page`);
  eq(await canScript(), "denied", "after a cross-origin navigation");
  await contents.loadURL(`${site}/page`);
  eq(await canScript(), "denied", "back on the granted origin");

  ses.extensions.grantActiveTab(extension.id, contents);
  ses.extensions.revokeActiveTab(extension.id, contents);
  eq(await canScript(), "denied", "after revokeActiveTab");
});
