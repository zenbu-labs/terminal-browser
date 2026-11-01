// Chrome lets a risky type through without Keep/Discard only for the very navigation the user typed, and for a
// click from a frame whose site was visited before today. chrome.downloads.show only ever reveals.
// Nothing downloaded here is ever opened: shell.openPath and showItemInFolder are replaced by recorders.
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { app, BrowserWindow, shell } = require("electron");

const profile = process.env.PROBE_PROFILE;
for (const variable of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) {
  process.env[variable] = path.join(profile, variable.toLowerCase());
}
const downloadsDir = path.join(profile, "Downloads");
fs.mkdirSync(downloadsDir, { recursive: true });
app.setPath("downloads", downloadsDir);
app.setName("terminal-browser");

const opened = [];
const revealed = [];
shell.openPath = async (file) => {
  opened.push(file);
  return "";
};
shell.showItemInFolder = (file) => revealed.push(file);

const dist = path.join(__dirname, "../../dist");
const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

require("./harness.cjs").run("downloads-danger-scope", async ({ eq, check, sleep }) => {
  const requests = new Map();
  const held = [];
  const attachment = (res, name) =>
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${name}"` }).end("echo harmless\n");
  const html = (res, body) => res.writeHead(200, { "Content-Type": "text/html" }).end(`<!doctype html><title>probe</title>${body}`);
  const handler = (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const count = (requests.get(url.pathname) ?? 0) + 1;
    requests.set(url.pathname, count);
    const link = (href, name) => `<a id="dl" href="${href}" download="${name}">download</a>`;
    switch (url.pathname) {
      case "/typed":
        if (count === 1) return res.writeHead(302, { Location: "/home" }).end();
        return attachment(res, "Installer.pkg");
      case "/home":
        return html(res, link("/typed", "Installer.pkg"));
      case "/hang":
        if (count === 1) return held.push(res);
        return attachment(res, "Hang.pkg");
      case "/to-file":
        return res.writeHead(302, { Location: "/Redirected.pkg" }).end();
      case "/frame":
        return html(res, link("/Update.dmg", "Update.dmg"));
      case "/top":
        return html(res, `<iframe src="${url.searchParams.get("frame")}/frame"></iframe>${link("/Update.dmg", "Update.dmg")}`);
      case "/page":
        return html(res, "");
      default:
        return attachment(res, path.basename(url.pathname));
    }
  };
  const visitedServer = await listen(handler);
  const newServer = await listen(handler);
  const visitedSite = `http://127.0.0.1:${visitedServer.address().port}`;
  const newSite = `http://127.0.0.1:${newServer.address().port}`;

  const { startBrowsing } = require(path.join(dist, "browsing/index.js"));
  const { downloads, history } = startBrowsing();
  const shared = require(require.resolve("shared", { paths: [dist] }));
  shared.addHistoryVisit({ url: `${visitedSite}/old`, time: Date.now() - TWO_DAYS, transition: "link" });

  let typed = null;
  try {
    typed = require(path.join(dist, "browsing/typed.js"));
  } catch {}
  // What the address bar does when the user submits a URL, in this tab or in a new one.
  const typeInto = (contents, url) => {
    const load = () => void contents.loadURL(url).catch(() => {});
    if (typed) typed.navigateTyped(contents, load);
    else {
      history.typedUrl(url);
      load();
    }
  };
  const openTypedTab = (url) => {
    const window = new BrowserWindow({ show: false });
    if (typed) typed.openedFromAddressBar(window.webContents);
    else history.typedUrl(url);
    void window.loadURL(url).catch(() => {});
    return window;
  };

  const heldBytes = () =>
    fs.readdirSync(downloadsDir).some((name) => name.endsWith(".crdownload") && fs.statSync(path.join(downloadsDir, name)).size > 0);
  const settled = async (id) => {
    for (let i = 0; i < 300; i++) {
      const record = downloads.get(id);
      if (record && (record.state !== "in_progress" || (record.danger === "file" && heldBytes()))) return record;
      await sleep(50);
    }
    throw new Error(`download ${id} never settled`);
  };
  const nextDownload = async (start) => {
    const created = new Promise((resolve) => {
      const stop = downloads.created.add((record) => {
        stop();
        resolve(record.id);
      });
    });
    await start();
    const record = await settled(await created);
    if (record.state === "in_progress") downloads.discard(record.id);
    return record;
  };
  const loaded = async (url) => {
    const window = new BrowserWindow({ show: false });
    await window.loadURL(url);
    return window;
  };
  const click = (frame, gesture) => frame.executeJavaScript(`document.getElementById("dl").click()`, gesture);

  // The URL the user typed, as the download itself and through a redirect, is let through like Chrome.
  const tab = await loaded(`${newSite}/page`);
  const direct = await nextDownload(() => typeInto(tab.webContents, `${newSite}/Direct.pkg`));
  eq(direct.danger, "safe", "typed URL that is the .pkg itself");
  const redirected = await nextDownload(() => typeInto(tab.webContents, `${newSite}/to-file`));
  eq(redirected.danger, "safe", "typed URL that redirects to the .pkg");
  const first = await nextDownload(() => openTypedTab(`${newSite}/First.pkg`).webContents);
  eq(first.danger, "safe", "the first page of a tab opened from the address bar");
  const plainTab = await nextDownload(async () => void new BrowserWindow({ show: false }).loadURL(`${newSite}/Plain.pkg`).catch(() => {}));
  eq(plainTab.danger, "file", "a tab opened by anything else");

  // R4-L1: a typed URL that redirected to a page, which then downloads the typed URL by script.
  const evil = new BrowserWindow({ show: false });
  const landed = new Promise((resolve) => evil.webContents.once("did-finish-load", resolve));
  typeInto(evil.webContents, `${newSite}/typed`);
  await landed;
  eq(evil.webContents.getURL(), `${newSite}/home`, "the typed URL redirected to a page");
  const script = await nextDownload(() => click(evil.webContents.mainFrame, false));
  eq([script.url, script.danger], [`${newSite}/typed`, "file"], "the page's script download of the typed URL");

  // R4-L1: another tab, and the page being replaced, while the typed navigation is still waiting for its server.
  const typedTab = await loaded(`${newSite}/page`);
  typeInto(typedTab.webContents, `${newSite}/hang`);
  const other = await loaded(`${newSite}/page`);
  const fromOther = await nextDownload(() => other.webContents.executeJavaScript(`Object.assign(document.createElement("a"), { href: "/hang", download: "Hang.pkg" }).click()`));
  eq(fromOther.danger, "file", "another tab's download of the URL typed elsewhere");
  const fromOldPage = await nextDownload(() => typedTab.webContents.mainFrame.executeJavaScript(`Object.assign(document.createElement("a"), { href: "/hang", download: "Hang.pkg" }).click()`));
  eq(fromOldPage.danger, "file", "the old page's download of the URL being typed");
  for (const res of held) res.writeHead(204).end();

  // R4-L2: a click in a never-visited iframe of a visited page, and in a visited site's iframe on a new page.
  const visitedTop = await loaded(`${visitedSite}/top?frame=${encodeURIComponent(newSite)}`);
  const adFrame = await nextDownload(() => click(visitedTop.webContents.mainFrame.frames[0], true));
  eq(adFrame.danger, "file", "a click in a never-visited iframe of a page visited before today");
  const topClick = await nextDownload(() => click(visitedTop.webContents.mainFrame, true));
  eq(topClick.danger, "safe", "a click on the page visited before today itself");
  const newTop = await loaded(`${newSite}/top?frame=${encodeURIComponent(visitedSite)}`);
  const visitedFrame = await nextDownload(() => click(newTop.webContents.mainFrame.frames[0], true));
  eq(visitedFrame.danger, "safe", "a click in an iframe from a site visited before today, like Chrome's referrer");
  const newTopClick = await nextDownload(() => click(newTop.webContents.mainFrame, true));
  eq(newTopClick.danger, "file", "a click on the never-visited page around it");

  // R4-L3: chrome.downloads.show on a missing file inside an app bundle, and showDefaultFolder.
  const handlers = new Map();
  const service = {
    loaded: new Map(),
    router: { handle: (name, run) => handlers.set(name, run) },
    events: { hasListener: () => false, listenerRemoved: { add() {} } },
    broadcast() {},
    dispatch() {},
    get: () => null,
    currentWindow: () => null,
  };
  require(path.join(dist, "extensions/api/downloads.js")).installDownloads(service);
  const extension = {
    id: "abcdefghijklmnopabcdefghijklmnop",
    name: "probe",
    path: "/nonexistent",
    manifest: { manifest_version: 3, name: "probe", version: "1" },
    allowsFileAccess: false,
    record: { installedAt: 1 },
    hasApiPermission: (permission) => permission === "downloads",
    hadRecentUserGesture: () => false,
  };
  const caller = { kind: "worker", extension };
  const bundle = path.join(downloadsDir, "Some.app");
  fs.mkdirSync(path.join(bundle, "Contents"), { recursive: true });
  const id = await handlers.get("downloads.download")(caller, { url: "data:,x", filename: "Some.app/x.pkg" });
  const record = await settled(id);
  eq([record.danger, fs.existsSync(record.filename)], ["file", false], "the PoC's .pkg is held and its name is free");
  await handlers.get("downloads.show")(caller, id);
  await handlers.get("downloads.showDefaultFolder")(caller);
  downloads.discard(id);
  eq(opened, [], "nothing reached shell.openPath (stubbed)");
  eq(revealed, [bundle, downloadsDir], "show and showDefaultFolder only reveal (stubbed)");
  check(fs.readdirSync(downloadsDir).every((name) => !name.endsWith(".crdownload")), "no unconfirmed files left");

  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  visitedServer.close();
  newServer.close();
});
