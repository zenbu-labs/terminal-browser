// Page icons load like Chrome's favicon download, an image the page itself requests: web and data: icons load,
// but an icon naming a local file, our pages or another extension's files is never fetched, nor is one that
// redirects there, and icons are size-capped and cookied only for the page's own origin.
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { BrowserWindow } = require("electron");

const pixelDir = path.dirname(require.resolve("@zenbu-labs/pixel/package.json", { paths: [path.join(__dirname, "../..")] }));
const { configureBrowserSession } = require(path.join(pixelDir, "dist/web/browser-session.js"));
const { FaviconCache } = require(path.join(pixelDir, "dist/web/favicon.js"));
const { requestHooks } = require(path.join(pixelDir, "dist/web/request-hooks.js"));
const scheme = require("../../dist/pages/scheme.js");
const { guardInternalNavigation } = require("../../dist/pages/navigation.js");

scheme.registerScheme();

const doc = (file) => `terminal-browser-file://file${file.split("/").map(encodeURIComponent).join("/")}`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==", "base64");

require("./harness.cjs").run("favicon", async ({ ses, eq, check }) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.PROBE_PROFILE, "files-")));
  const photo = path.join(root, "Private", "photo.png");
  fs.mkdirSync(path.dirname(photo));
  fs.writeFileSync(photo, PNG);

  const cookies = {};
  let localRequests = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname.endsWith(".png")) cookies[`${req.headers.host.split(":")[0]}${url.pathname}`] = req.headers.cookie ?? "";
    if (url.pathname === "/icon.png") return res.writeHead(200, { "Content-Type": "image/png" }).end(PNG);
    if (url.pathname === "/to-doc") return res.writeHead(302, { Location: doc(photo) }).end();
    if (url.pathname === "/to-file") return res.writeHead(302, { Location: `file://${photo}` }).end();
    if (url.pathname === "/to-icon") return res.writeHead(302, { Location: "/icon.png" }).end();
    if (url.pathname === "/huge.png") {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.write(PNG);
      return res.end(Buffer.alloc(8 * 1024 * 1024));
    }
    if (url.pathname === "/page.html") {
      const icons = [doc(photo), `file://${photo}`, "terminal-browser://settings/", "chrome-extension://abcdefghijklmnopabcdefghijklmnop/icon.png"];
      return res.writeHead(200, { "Content-Type": "text/html" }).end(`<!doctype html><title>icons</title>${icons.map((href) => `<link rel=icon href="${href}">`).join("")}`);
    }
    res.writeHead(404).end();
  });
  const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  const web = `http://127.0.0.1:${port}`;

  configureBrowserSession(ses);
  scheme.servePages(() => ({ cwd: root, theme: null }));
  guardInternalNavigation();
  requestHooks(ses).beforeRequest({ urls: ["terminal-browser-file://*/*", "terminal-browser://*/*", "file://*/*", "chrome-extension://*/*"] }, () => {
    localRequests++;
    return undefined;
  });
  await ses.cookies.set({ url: web, name: "session", value: "page-cookie" });
  await ses.cookies.set({ url: `http://localhost:${port}`, name: "other", value: "other-cookie" });

  const cache = new FaviconCache(path.join(process.env.PROBE_PROFILE, "favicons"));
  const window = new BrowserWindow({ show: false, webPreferences: { session: ses } });
  const named = new Promise((resolve) => window.webContents.once("page-favicon-updated", (_event, urls) => resolve(urls)));
  await window.loadURL(`${web}/page.html`);
  const urls = await Promise.race([named, new Promise((resolve) => setTimeout(() => resolve([]), 5000))]);
  check(urls.includes(doc(photo)), `the page named its icons: ${JSON.stringify(urls)}`);
  const origin = window.webContents.mainFrame.origin;
  eq(origin, web, "the page's origin");

  eq(await cache.resolve(urls, ses, origin), null, "a web page's icons naming local files, our pages and other extensions load nothing");
  eq(await cache.resolve([`${web}/to-doc`, `${web}/to-file`], ses, origin), null, "icons that redirect to local files load nothing");
  eq(localRequests, 0, "no local file or internal page was requested for an icon");

  eq(await cache.resolve([`${web}/huge.png`], ses, origin), null, "an oversized icon is refused");
  check((await cache.resolve([`${web}/icon.png`], ses, origin)) !== null, "a web icon loads");
  check((await cache.resolve([`${web}/to-icon`], ses, origin)) !== null, "a web icon behind a web redirect loads");
  check((await cache.resolve([`data:image/png;base64,${PNG.toString("base64")}`], ses, origin)) !== null, "a data: icon loads");
  await cache.resolve([`http://localhost:${port}/icon.png`], ses, origin);
  eq(cookies[`127.0.0.1/icon.png`], "session=page-cookie", "the page's own icon carries the page's cookies");
  eq(cookies[`localhost/icon.png`], "", "another origin's icon carries no cookies");

  const files = fs.readdirSync(path.join(process.env.PROBE_PROFILE, "favicons"));
  eq(files.length, 4, "only the web and data: icons were cached");
  window.destroy();
  server.close();
});
