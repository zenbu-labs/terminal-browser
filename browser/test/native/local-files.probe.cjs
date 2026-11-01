// A sandboxed local html page may load files from its own folder, and nothing else may reuse what it was allowed:
// not remote scripts it runs (reading other folders' scripts), and not web pages (an approval left by its request).
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { BrowserWindow } = require("electron");

const browserDir = path.join(__dirname, "../..");
const { requestHooks } = require(require.resolve("@zenbu-labs/pixel", { paths: [browserDir] }));
const scheme = require("../../dist/pages/scheme.js");
const { listenForUserActivation } = require("../../dist/extensions/user-activation.js");

scheme.registerScheme();

function serve(routes) {
  const server = http.createServer((req, res) => {
    const route = routes[new URL(req.url, "http://127.0.0.1").pathname];
    if (!route) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": route[0] }).end(route[1]);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

require("./harness.cjs").run("local-files", async ({ ses, port, waitReport, check, eq, sleep }) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.PROBE_PROFILE, "files-")));
  const site = path.join(root, "site");
  const secrets = path.join(root, "secrets");
  fs.mkdirSync(path.join(site, "assets"), { recursive: true });
  fs.mkdirSync(secrets);
  fs.writeFileSync(path.join(secrets, "secrets.js"), "window.API_TOKEN = 'token';");
  fs.writeFileSync(path.join(secrets, "other.html"), "<!doctype html><title>other folder</title>");
  fs.symlinkSync(secrets, path.join(site, "linked"));
  fs.writeFileSync(path.join(site, "assets", "app.js"), "window.APP = 'app';");
  fs.writeFileSync(path.join(site, "assets", "data.js"), "window.DATA = 'data';");
  const doc = (file) => `terminal-browser-file://file${file}`;
  const report = (key, expr) => `fetch("http://127.0.0.1:${port}/report?key=${key}&value=" + encodeURIComponent(JSON.stringify(${expr})));`;

  const remote = await serve({
    "/collect.js": ["text/javascript", report("collect", "{ app: window.APP ?? null, token: window.API_TOKEN ?? null, encoded: window.ENCODED ?? null, linked: window.LINKED ?? null }")],
    "/web.html": [
      "text/html",
      `<!doctype html><script src="${doc(path.join(site, "assets", "data.js"))}?once"></script><script>${report("web", "window.DATA ?? null")}</script>`,
    ],
  });
  fs.writeFileSync(path.join(secrets, "encoded.js"), "window.ENCODED = 'encoded';");
  fs.writeFileSync(path.join(secrets, "linked.js"), "window.LINKED = 'linked';");
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="7" height="5"/>';
  fs.writeFileSync(path.join(site, "assets", "inside.svg"), svg);
  fs.writeFileSync(path.join(secrets, "outside.svg"), svg);
  fs.writeFileSync(
    path.join(site, "page.html"),
    [
      "<!doctype html><title>local</title>",
      '<script src="assets/app.js"></script>',
      `<script src="${doc(path.join(secrets, "secrets.js"))}"></script>`,
      '<script src="assets/..%2F..%2Fsecrets%2Fencoded.js"></script>',
      '<script src="linked/linked.js"></script>',
      `<script src="http://127.0.0.1:${remote}/collect.js"></script>`,
    ].join("\n"),
  );

  scheme.servePages(() => ({ cwd: root, theme: null }));
  listenForUserActivation();
  let aborted = false;
  requestHooks(ses).beforeSendHeaders((details) => {
    if (aborted || !details.url.endsWith("data.js?once") || details.initiatorOrigin !== "null") return;
    aborted = true;
    return "cancel";
  });

  const local = new BrowserWindow({ show: false, webPreferences: { session: ses } });
  await local.loadURL(doc(path.join(site, "page.html")));
  eq(await waitReport("collect"), { app: "app", token: null, encoded: null, linked: null }, "a remote script in a local page reads only its own folder's scripts");

  const width = (src) =>
    local.webContents.executeJavaScript(
      `new Promise((resolve) => { const i = new Image(); i.onload = () => resolve(i.naturalWidth); i.onerror = () => resolve(0); i.src = ${JSON.stringify(src)}; })`,
    );
  eq([await width("assets/inside.svg"), await width("../secrets/outside.svg")], [7, 0], "a local page shows its own folder's images and not others'");

  await local.webContents.executeJavaScript(
    `new Promise((resolve) => { const s = document.createElement("script"); s.src = "assets/data.js?once"; s.onload = s.onerror = resolve; document.head.append(s); })`,
  );
  eq(aborted, true, "the local page's aborted request was vetted");
  const web = new BrowserWindow({ show: false, webPreferences: { session: ses } });
  await web.loadURL(`http://127.0.0.1:${remote}/web.html`);
  eq(await waitReport("web"), null, "a web page can't redeem the approval a local page's aborted request left");
  eq(
    await local.webContents.executeJavaScript(
      `new Promise((resolve) => { const s = document.createElement("script"); s.src = "assets/data.js?once"; s.onload = () => resolve(window.DATA); s.onerror = () => resolve("refused"); document.head.append(s); })`,
    ),
    "data",
    "the local page still loads the file itself",
  );
  web.destroy();
  fs.mkdirSync(path.join(site, "store"), { mode: 0o755 });
  fs.mkdirSync(path.join(site, "modules"), { mode: 0o755 });
  fs.writeFileSync(path.join(site, "store", "pkg.js"), "window.PKG = 'pkg';");
  fs.linkSync(path.join(site, "store", "pkg.js"), path.join(site, "modules", "pkg.js"));
  fs.mkdirSync(path.join(site, "drop"));
  fs.chmodSync(path.join(site, "drop"), 0o777);
  fs.linkSync(path.join(secrets, "secrets.js"), path.join(site, "drop", "secrets.js"));
  const loads = (src, global) =>
    local.webContents.executeJavaScript(
      `new Promise((resolve) => { const s = document.createElement("script"); s.src = ${JSON.stringify(src)}; s.onload = () => resolve(window.${global} ?? null); s.onerror = () => resolve("refused"); document.head.append(s); })`,
    );
  eq(await loads("modules/pkg.js", "PKG"), "pkg", "a hard link only its owner could have placed loads, as in a pnpm node_modules");
  eq(await loads("drop/secrets.js", "API_TOKEN"), "refused", "a hard link in a folder others can write to is refused");
  const opener = new BrowserWindow({ show: false, webPreferences: { session: ses } });
  await opener.loadURL(doc(path.join(site, "page.html")));
  await opener.webContents.executeJavaScript(`location.href = "../secrets/other.html"; 1`);
  await sleep(1000);
  check(opener.webContents.getTitle() !== "other folder", "a local page doesn't open a page in another folder by itself");
  await opener.loadURL(doc(path.join(site, "page.html")));
  await opener.webContents.executeJavaScript(
    `document.body.innerHTML = '<a href="../secrets/other.html" style="display:block;height:100px">other</a>'; 1`,
  );
  opener.webContents.sendInputEvent({ type: "mouseDown", x: 20, y: 20, button: "left", clickCount: 1 });
  opener.webContents.sendInputEvent({ type: "mouseUp", x: 20, y: 20, button: "left", clickCount: 1 });
  for (let i = 0; i < 50 && opener.webContents.getTitle() !== "other folder"; i++) await sleep(100);
  eq(opener.webContents.getTitle(), "other folder", "a click on its link opens a page in another folder");
  opener.destroy();
  fs.renameSync(site, `${site}-away`);
  fs.symlinkSync(secrets, site);
  eq(
    await local.webContents.executeJavaScript(
      `new Promise((resolve) => { const s = document.createElement("script"); s.src = "secrets.js"; s.onload = () => resolve(window.API_TOKEN); s.onerror = () => resolve("refused"); document.head.append(s); })`,
    ),
    "refused",
    "a local page's folder swapped for a link after it loaded gives it nothing from the link's target",
  );
  local.destroy();
});
