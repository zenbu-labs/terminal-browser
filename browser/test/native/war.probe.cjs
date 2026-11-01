// web_accessible_resources (patch 0024): an extension with a devtools_page still only exposes the resources it lists,
// to the pages and extensions it lists them for.
const { BrowserWindow } = require("electron");

require("./harness.cjs").run("war", async ({ ses, port, waitReport, writeExtension, eq }) => {
  const target = writeExtension("target", port, {
    "manifest.json": {
      manifest_version: 3,
      name: "target",
      version: "1",
      devtools_page: "devtools.html",
      web_accessible_resources: [{ resources: ["war.txt"], matches: ["http://127.0.0.1/*"] }],
    },
    "devtools.html": "",
    "war.txt": "war",
    "secret.txt": "secret",
  });
  const targetExtension = await ses.extensions.loadExtension(target);
  const base = targetExtension.url;
  const other = writeExtension("other", port, {
    "manifest.json": { manifest_version: 3, name: "other", version: "1", background: { service_worker: "sw.js" } },
    "sw.js": `importScripts("report.js");
      Promise.all(["war.txt", "secret.txt", "manifest.json"].map((f) => fetch("${base}" + f).then((r) => r.status, () => "blocked")))
        .then((r) => report("other", r));`,
  });
  await ses.extensions.loadExtension(other);
  eq(await waitReport("other"), ["blocked", "blocked", "blocked"], "another extension reading the files");

  const page = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await page.loadURL(`http://127.0.0.1:${port}/page`);
  const fromPage = await page.webContents.executeJavaScript(
    `Promise.all(["war.txt", "secret.txt"].map((f) => fetch("${base}" + f).then((r) => r.text(), () => "blocked")))`,
  );
  eq(fromPage, ["war", "blocked"], "a matching page reading the files");
});
