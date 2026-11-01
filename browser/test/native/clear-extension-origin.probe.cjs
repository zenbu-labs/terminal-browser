// session.clearData with an origins filter never reaches an extension's storage: like Chrome's browsingData
// default (unprotected web origins only), it clears web-storage schemes only, which chrome-extension isn't.
const { BrowserWindow } = require("electron");

require("./harness.cjs").run("clear-extension-origin", async ({ ses, port, writeExtension, eq }) => {
  const victim = await ses.extensions.loadExtension(
    writeExtension("victim", port, { "manifest.json": { manifest_version: 3, name: "victim", version: "1" }, "page.html": "victim" }),
  );
  const page = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await page.loadURL(`${victim.url}page.html`);
  const idb = `new Promise((resolve) => { const r = indexedDB.open("db"); r.onupgradeneeded = () => r.result.createObjectStore("s"); r.onsuccess = () => resolve(r.result); })`;
  await page.webContents.executeJavaScript(`(async () => {
    localStorage.setItem("k", "v");
    await (await caches.open("c")).put("https://cache.test/x", new Response("x"));
    const db = await ${idb};
    await new Promise((resolve) => { const t = db.transaction("s", "readwrite"); t.objectStore("s").put("v", "k"); t.oncomplete = resolve; });
    db.close();
    return 1;
  })()`);
  const stored = () =>
    page.webContents.executeJavaScript(`(async () => {
      const db = await ${idb};
      const idbValue = await new Promise((resolve) => { const r = db.transaction("s").objectStore("s").get("k"); r.onsuccess = () => resolve(r.result ?? null); r.onerror = () => resolve(null); });
      db.close();
      return { local: localStorage.getItem("k"), cache: (await (await caches.open("c")).keys()).length, idb: idbValue };
    })()`);

  await ses.clearData({
    origins: [victim.url.replace(/\/$/, "")],
    dataTypes: ["localStorage", "cacheStorage", "indexedDB", "serviceWorkers", "fileSystems"],
  });
  await page.reload();
  eq(await stored(), { local: "v", cache: 1, idb: "v" }, "extension storage after clearData for its origin");
});
