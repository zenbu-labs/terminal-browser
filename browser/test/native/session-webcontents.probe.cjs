// session.clearData({ since }) (patch 0029) with the httpCache/cacheStorage types (0037), webContents
// "zoom-level-changed" (0030) and setZoomMode(mode, { persist }) (0038).
const { BrowserWindow } = require("electron");

require("./harness.cjs").run("session-webcontents", async ({ ses, port, eq, sleep }) => {
  const url = `http://127.0.0.1:${port}/`;
  await ses.cookies.set({ url, name: "old", value: "1", expirationDate: Date.now() / 1000 + 3600 });
  await sleep(50);
  const since = Date.now();
  await sleep(50);
  await ses.cookies.set({ url, name: "new", value: "1", expirationDate: Date.now() / 1000 + 3600 });
  await ses.clearData({ dataTypes: ["cookies"], since });
  eq((await ses.cookies.get({ url })).map((c) => c.name), ["old"], "cookies left after clearData since");

  const page = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  const changes = [];
  page.webContents.on("zoom-level-changed", (_event, details) => changes.push(details));
  await page.loadURL(`${url}page`);
  page.webContents.setZoomFactor(1.5);
  await sleep(300);
  page.webContents.setZoomMode("disabled");
  await sleep(300);
  eq(changes, [{ oldZoomFactor: 1, newZoomFactor: 1.5 }, { oldZoomFactor: 1.5, newZoomFactor: 1 }], "zoom-level-changed");

  page.webContents.setZoomMode("isolated", { persist: false });
  await page.loadURL(`${url}page?next`);
  eq(page.webContents.getZoomMode(), "default", "per-tab zoom mode after navigating with persist: false");
  page.webContents.setZoomMode("isolated");
  await page.loadURL(`${url}page?again`);
  eq(page.webContents.getZoomMode(), "isolated", "per-tab zoom mode after navigating by default");

  const cached = () =>
    page.webContents.executeJavaScript(`caches.open("probe").then((c) => c.keys()).then((k) => k.length)`);
  await page.webContents.executeJavaScript(`caches.open("probe").then((c) => c.put("/x", new Response("x"))).then(() => 1)`);
  await ses.clearData({ dataTypes: ["httpCache"] });
  eq(await cached(), 1, "Cache Storage after clearing the HTTP cache");
  await ses.clearData({ dataTypes: ["cacheStorage"], since: Date.now() + 60000 });
  eq(await cached(), 1, "Cache Storage after clearing only newer Cache Storage");
  await ses.clearData({ dataTypes: ["cacheStorage"] });
  eq(await cached(), 0, "Cache Storage after clearing it");
});
