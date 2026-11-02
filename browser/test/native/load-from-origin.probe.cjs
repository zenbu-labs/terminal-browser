// webContents.loadURL(url, { initiatorOrigin }) (patch 0035): navigations an extension starts carry its origin, so
// another extension's private page is blocked like in Chrome, and entries the user never interacted with are skipped
// by back navigation.
const { BrowserWindow } = require("electron");

require("./harness.cjs").run("load-from-origin", async ({ ses, port, writeExtension, eq, sleep }) => {
  const caller = await ses.extensions.loadExtension(
    writeExtension("caller", port, { "manifest.json": { manifest_version: 3, name: "caller", version: "1" } }),
  );
  const other = await ses.extensions.loadExtension(
    writeExtension("other", port, {
      "manifest.json": { manifest_version: 3, name: "other", version: "1", web_accessible_resources: [{ resources: ["open.html"], matches: ["<all_urls>"], extension_ids: ["*"] }] },
      "private.html": "private",
      "open.html": "open",
    }),
  );
  let tab = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  const load = (url, options) =>
    tab.webContents.loadURL(url, options).then(
      () => "loaded",
      (error) => error.code ?? error.message,
    );
  await load(`http://127.0.0.1:${port}/page?start`);

  eq(await load(`${other.url}private.html`, { initiatorOrigin: caller.url }), "ERR_BLOCKED_BY_CLIENT", "other extension's private page");
  eq(await load(`${other.url}open.html`, { initiatorOrigin: caller.url }), "loaded", "other extension's web accessible page");
  eq(await load(`${other.url}private.html`), "loaded", "the same page loaded by the app");

  tab = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await load(`http://127.0.0.1:${port}/page?start`);
  await load(`http://127.0.0.1:${port}/page?a`, { initiatorOrigin: caller.url });
  await sleep(200);
  await load(`http://127.0.0.1:${port}/page?b`, { initiatorOrigin: caller.url });
  await sleep(200);
  eq(tab.webContents.navigationHistory.canGoBack(), false, "back past pages nobody interacted with");

  await load(`http://127.0.0.1:${port}/page?c`);
  await load(`http://127.0.0.1:${port}/page?d`);
  eq(tab.webContents.navigationHistory.canGoBack(), true, "back after app navigations");
});
