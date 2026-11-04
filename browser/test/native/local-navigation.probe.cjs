// Who may open a local document: web pages and extension pages never commit one (not even an empty refusal at
// its URL), a copy of a tab never loads one the tab was refused, markdown stays in its folder, and a local page
// opens other folders' pages only on the user's click and never turns another folder's file into a download.
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { BrowserWindow } = require("electron");

const pixelDir = path.dirname(require.resolve("@zenbu-labs/pixel/package.json", { paths: [path.join(__dirname, "../..")] }));
const { configureBrowserSession } = require(path.join(pixelDir, "dist/web/browser-session.js"));
const scheme = require("../../dist/pages/scheme.js");
const { guardInternalNavigation } = require("../../dist/pages/navigation.js");
const { browserMayReload } = require("../../dist/pages/local-navigation.js");
const { windowOpenRoute } = require("../../dist/pages/window-open.js");
const { listenForUserActivation } = require("../../dist/extensions/user-activation.js");
const { loadURLFromOrigin } = require("../../dist/extensions/native.js");
const { captureVisiblePageError } = require("../../dist/extensions/api/page-capture.js");
const { restrictedUrlError } = require("../../dist/extensions/loaded.js");

scheme.registerScheme();

const docUrl = (host, file) => `terminal-browser-file://${host}${file.split("/").map(encodeURIComponent).join("/")}`;
const doc = (file) => docUrl("file", file);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==", "base64");
const BINARY = Buffer.from([0, 1, 2, 3, 0x54, 0x4f, 0x50]);

function serve(routes) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const route = routes[url.pathname];
    if (!route) return res.writeHead(404).end();
    const [type, body] = typeof route === "function" ? route(url) : route;
    res.writeHead(200, { "Content-Type": type }).end(body);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function settle(contents, ms = 500) {
  for (let i = 0; i < 100 && contents.isLoading(); i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, ms));
}

function watchCommits(contents) {
  const commits = [];
  contents.on("did-navigate", (_event, url, code) => commits.push({ url, code }));
  return commits;
}

async function click(contents, selector) {
  const rect = await contents.executeJavaScript(
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`,
  );
  const [x, y] = rect.map(Math.round);
  contents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
  contents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
}

require("./harness.cjs").run("local-navigation", async ({ ses, writeExtension, port, check, eq, sleep }) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.PROBE_PROFILE, "files-")));
  const site = path.join(root, "site");
  const secret = path.join(root, "secret");
  const repo = path.join(root, "repo");
  const pictures = path.join(root, "Pictures");
  for (const dir of [site, secret, repo, pictures]) fs.mkdirSync(dir);
  const key = path.join(secret, "id_ed25519");
  fs.writeFileSync(key, "-----BEGIN OPENSSH PRIVATE KEY-----\nTOPSECRET-KEY\n");
  fs.writeFileSync(path.join(secret, "blob.bin"), BINARY);
  fs.writeFileSync(path.join(secret, "other.html"), "<!doctype html><title>other folder</title>");
  fs.writeFileSync(path.join(site, "data.bin"), BINARY);
  fs.writeFileSync(path.join(site, "next.html"), "<!doctype html><title>next</title>");
  const block = (id, href) => `<a id=${id} href="${href}" style="display:block;height:40px">${id}</a>`;
  fs.writeFileSync(
    path.join(site, "page.html"),
    `<!doctype html><title>page</title><p id=blank style="height:40px">blank</p>${block("other", "../secret/other.html")}${block("bin", "../secret/blob.bin")}${block("localbin", "data.bin")}`,
  );

  const downloads = [];
  configureBrowserSession(ses);
  scheme.servePages(() => ({ cwd: root, theme: null }));
  guardInternalNavigation();
  listenForUserActivation();
  ses.on("will-download", (event, item) => {
    downloads.push({ file: path.basename(item.getURL()), allowed: !event.defaultPrevented });
    if (!event.defaultPrevented) item.cancel();
  });

  const hits = [];
  const web = await serve({
    "/evil.html": ["text/html", "<!doctype html><title>evil</title><iframe id=f></iframe>"],
    "/beacon": (url) => {
      hits.push(url.searchParams.get("probe"));
      return ["image/gif", ""];
    },
  });

  // R6-L2: a web page navigating itself or a frame to a local document.
  const tab = new BrowserWindow({ show: false, webPreferences: { session: ses } });
  const contents = tab.webContents;
  const commits = watchCommits(contents);
  await contents.loadURL(`http://127.0.0.1:${web}/evil.html`);
  await contents.executeJavaScript(`f.src = ${JSON.stringify(doc(key))}; 1`);
  await contents.executeJavaScript(`location.href = ${JSON.stringify(doc(key))}; 1`).catch(() => {});
  await settle(contents, 800);
  eq(contents.getURL(), `http://127.0.0.1:${web}/evil.html`, "a web page's navigation to a local document doesn't commit");
  const frames = contents.mainFrame.framesInSubtree.map((frame) => [frame.url, frame.origin]);
  check(!JSON.stringify(frames).includes("terminal-browser-file"), `a web page's frame shows a local document: ${JSON.stringify(frames)}`);
  check(!commits.some((commit) => commit.url.startsWith("terminal-browser-file")), `a local url was committed: ${JSON.stringify(commits)}`);

  // R6-M2: an extension page (no file access) navigating to the local document under its own id.
  const ext = writeExtension("capture", port, {
    "manifest.json": { manifest_version: 3, name: "capture", version: "1", host_permissions: ["<all_urls>"] },
    "nav.html": "<!doctype html><title>nav</title>",
  });
  const { id } = await ses.extensions.loadExtension(ext);
  const ownHost = docUrl(id, key);
  for (const target of [ownHost, doc(key)]) {
    await contents.loadURL(`chrome-extension://${id}/nav.html`);
    await contents.executeJavaScript(`location.href = ${JSON.stringify(target)}; 1`).catch(() => {});
    await settle(contents, 800);
    eq(contents.getURL(), `chrome-extension://${id}/nav.html`, `an extension page's navigation to ${target} doesn't commit`);
  }

  // Past every navigation check, as tabs.duplicate or sessions.restore loading the URL for a page or an extension:
  // the scheme handler refuses with no document of ours, and the URL never counts as one the browser showed.
  for (const origin of [`http://127.0.0.1:${web}`, `chrome-extension://${id}/`]) {
    commits.length = 0;
    await loadURLFromOrigin(contents, ownHost, origin).catch(() => {});
    await settle(contents);
    const text = await contents.executeJavaScript("document.body?.innerText ?? ''").catch(() => "");
    check(!text.includes("TOPSECRET"), `a load from ${origin} showed the file`);
    eq(commits, [], `a load from ${origin} commits no document`);
    check(contents.mainFrame.origin !== "terminal-browser-file://file", `a load from ${origin} left a ${contents.mainFrame.origin} document`);
    eq(browserMayReload(contents, ownHost), false, "a copy of the tab doesn't load the refused url as the browser");
  }
  const extension = { id, hasAllUrls: true, hasActiveTab: () => false, pageAccessError: (url) => restrictedUrlError(url, id, true) };
  check(captureVisiblePageError(extension, contents.id, ownHost) !== null, "captureVisibleTab allows a local document whose host is the extension's id");

  // A local document the browser opened, and a link in its own folder, still count as shown.
  await contents.loadURL(doc(path.join(site, "next.html")));
  eq(browserMayReload(contents, `${doc(path.join(site, "next.html"))}#top`), true, "a copy of a local document the browser showed loads it");

  // R6-L3: markdown stays in its folder, and shows nothing that tells a remote server what exists elsewhere.
  fs.writeFileSync(path.join(pictures, "exists.png"), PNG);
  fs.writeFileSync(path.join(repo, "own.png"), PNG);
  const markdown = (probe, image) =>
    `# readme\n\n<img id=own src="own.png">\n\n${Array(30).fill(`<img src="${image}" width="20000">`).join("\n")}\n\n<img loading="lazy" src="http://127.0.0.1:${web}/beacon?probe=${probe}">\n`;
  fs.writeFileSync(path.join(repo, "a.md"), markdown("exists", path.join(pictures, "exists.png")));
  fs.writeFileSync(path.join(repo, "b.md"), markdown("missing", path.join(pictures, "missing.png")));
  const shown = [];
  for (const name of ["a.md", "b.md"]) {
    await contents.loadURL(doc(path.join(repo, name)));
    await sleep(1200);
    shown.push(await contents.executeJavaScript("[String(origin), ...[...document.images].slice(0, 3).map((i) => i.naturalWidth)]"));
  }
  eq(shown, [["null", 2, 0, 0], ["null", 2, 0, 0]], "markdown runs opaque, shows its folder's image and nothing from another folder");
  eq(hits.includes("exists"), hits.includes("missing"), `a remote server tells an existing image from a missing one (${hits})`);

  // R6-L4: a local page's navigations to other folders and to downloads.
  const page = doc(path.join(site, "page.html"));
  const go = async (href) => {
    await contents.loadURL(page);
    await contents.executeJavaScript(`location.href = ${JSON.stringify(href)}; 1`).catch(() => {});
    await settle(contents, 800);
    return contents.getTitle();
  };
  eq(await go("next.html"), "next", "a local page opens a page in its own folder");
  eq(await go("../secret/other.html"), "page", "a local page doesn't open another folder's page by itself");
  eq(await go(doc(key)), "page", "a local page doesn't open another folder's file by itself");
  await go("../secret/blob.bin");
  await go("data.bin");
  await contents.loadURL(page);
  await contents.executeJavaScript(`(() => { const a = document.createElement("a"); a.href = "data.bin"; a.download = ""; a.click(); return 1; })()`);
  await settle(contents, 800);
  eq(downloads.filter((download) => download.allowed), [], "a local page downloads nothing by itself");
  eq(
    windowOpenRoute(contents, { url: doc(path.join(secret, "other.html")), referrer: { url: "", policy: "no-referrer" } }),
    null,
    "a local page opens no tab of another folder's page by itself",
  );
  eq(
    windowOpenRoute(contents, { url: doc(path.join(site, "next.html")), referrer: { url: "", policy: "no-referrer" } })?.mayDownload,
    false,
    "a tab a local page opens by itself in its folder shows a page and doesn't download",
  );

  downloads.length = 0;
  await contents.loadURL(page);
  await settle(contents);
  await click(contents, "#other");
  await settle(contents, 800);
  eq(contents.getTitle(), "other folder", "a click on a link opens a page in another folder");
  await contents.loadURL(page);
  await settle(contents);
  await click(contents, "#bin");
  await settle(contents, 800);
  await contents.loadURL(page);
  await settle(contents);
  await click(contents, "#localbin");
  await settle(contents, 800);
  eq(downloads, [{ file: "blob.bin", allowed: false }, { file: "data.bin", allowed: true }], "a click downloads a file from the page's folder only");
  await contents.loadURL(page);
  await settle(contents);
  await click(contents, "#blank");
  await sleep(300);
  const route = windowOpenRoute(contents, { url: doc(path.join(secret, "blob.bin")), referrer: { url: "", policy: "no-referrer" } });
  eq([route?.url, route?.mayDownload], [doc(path.join(secret, "blob.bin")), false], "after a click, a tab of another folder's file opens without downloading it");
  tab.destroy();
});
