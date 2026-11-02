// session.clearData({ since }) (patch 0029) and webContents "zoom-level-changed" (0030).
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
});
