const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const electron = require("./fake-electron.js");
const { servePages } = require("../dist/pages/scheme.js");
const { LocalFileAccess } = require("../dist/pages/local-files.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-local-files-"));
fs.writeFileSync(path.join(dir, "exists.js"), "window.leaked = 1;");
const existing = `terminal-browser-file://file${dir}/exists.js`;
const missing = `terminal-browser-file://file${dir}/missing.js`;

class FakeWebRequest extends electron.FakeWebRequest {
  get listener() {
    return this.sendHeaders;
  }
}

function frame(url, parent = null) {
  return { url, parent };
}

function vet(webRequest, details) {
  let result;
  webRequest.listener({ resourceType: "script", requestHeaders: {}, ...details }, (response) => (result = response));
  return result;
}

const GRANT = "x-terminal-browser-file-grant";
const grantOf = (response) => response.requestHeaders?.[GRANT];

const session = electron.session.defaultSession;
session.webRequest = new FakeWebRequest();
servePages(() => ({ cwd: dir, theme: null }));
const handler = session.protocols.get("terminal-browser-file");
const request = (url, initiatorOrigin, headers = {}) => handler({ url, headers: new Headers(headers), initiatorOrigin });
const statusOf = (response) => (response.type === "error" ? "refused" : response.status);

function openLocalPageWithoutLoading(url) {
  const contents = Object.assign(new EventEmitter(), {
    session,
    isDestroyed: () => false,
    mainFrame: { framesInSubtree: [frame(url)] },
  });
  electron.app.emit("web-contents-created", {}, contents);
  contents.emit("did-start-navigation", { url });
  return contents;
}

// Opens a local page the way a tab does: the browser loads it, then its frame shows it.
async function openLocalPage(url) {
  const file = decodeURIComponent(new URL(url).pathname);
  if (!fs.existsSync(file)) fs.writeFileSync(file, "<!doctype html><title>page</title>");
  assert.equal((await request(url, undefined)).status, 200);
  return openLocalPageWithoutLoading(url);
}

function closeLocalPage(contents) {
  contents.mainFrame.framesInSubtree = [];
  contents.emit("did-stop-loading");
}

test("web content of any origin, opaque or local included, gets the same network error for existing and missing files", async () => {
  for (const initiator of ["null", "https://evil.example", "chrome-extension://abc", "file://", "data:", "terminal-browser-file://file"]) {
    assert.equal(statusOf(await request(existing, initiator)), "refused", initiator);
    assert.equal(statusOf(await request(missing, initiator)), "refused", initiator);
  }
});

test("the browser and our pages still load local files", async () => {
  assert.equal((await request(existing, undefined)).status, 200);
  assert.equal(statusOf(await request(missing, undefined)), "refused");
  assert.equal((await request(existing, "terminal-browser://history")).status, 200);
});

test("local files are served with nosniff so a mislabeled file never runs as script", async () => {
  const response = await request(existing, undefined);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("while a sandboxed local page is open, its own requests get a one-time grant and web frames' are cancelled", async () => {
  const webRequest = new FakeWebRequest();
  const access = new LocalFileAccess({ webRequest });
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    mainFrame: { framesInSubtree: [frame(`terminal-browser-file://file${dir}/page.html`)] },
  });
  access.opening(contents);

  const local = frame(`terminal-browser-file://file${dir}/page.html`);
  const srcdocInLocal = frame("about:srcdoc", local);
  const evilTop = frame("https://evil.example/");
  const srcdocInEvil = frame("about:srcdoc", evilTop);
  const dataFrame = frame("data:text/html,x", local);
  const redeem = (url, token, initiatorOrigin = "null") =>
    access.redeem({ url, headers: new Headers(token ? { [GRANT]: token } : {}), initiatorOrigin });

  const first = grantOf(vet(webRequest, { url: existing, initiatorOrigin: "null", frame: local }));
  const second = grantOf(vet(webRequest, { url: `${existing}#x`, initiatorOrigin: "null", frame: srcdocInLocal }));
  assert.ok(first && second && first !== second);
  assert.equal(redeem(missing, first), null);
  assert.equal(redeem(existing, first), null);
  assert.deepEqual(redeem(existing, second), { url: existing, page: path.join(dir, "page.html") });
  assert.equal(redeem(existing, second), null);

  for (const sender of [srcdocInEvil, dataFrame, evilTop, null]) {
    assert.deepEqual(vet(webRequest, { url: missing, initiatorOrigin: "null", frame: sender }), { cancel: true });
    assert.deepEqual(vet(webRequest, { url: existing, initiatorOrigin: "null", frame: sender }), { cancel: true });
  }

  const forged = vet(webRequest, { url: existing, initiatorOrigin: "https://evil.example", frame: evilTop, requestHeaders: { [GRANT]: "guess" } });
  assert.equal(grantOf(forged), undefined);
  const stolen = grantOf(vet(webRequest, { url: existing, initiatorOrigin: "null", frame: local }));
  assert.equal(redeem(existing, stolen, "https://evil.example"), null);
  assert.equal(redeem(existing, stolen), null);

  const pending = grantOf(vet(webRequest, { url: existing, initiatorOrigin: "null", frame: local }));
  contents.mainFrame.framesInSubtree = [frame("https://example.com/")];
  access.settled(contents);
  assert.equal(webRequest.listener, null);
  assert.equal(redeem(existing, pending), null);
});

test("a web request can't take the grant made for a local page's request to the same file", async () => {
  const page = `terminal-browser-file://file${dir}/page.html`;
  const contents = await openLocalPage(page);
  const token = grantOf(vet(session.webRequest, { url: existing, initiatorOrigin: "null", frame: frame(page) }));
  assert.ok(token);
  assert.equal(statusOf(await request(existing, "https://evil.example")), "refused");
  assert.equal(statusOf(await request(existing, "https://evil.example", { [GRANT]: token })), "refused");
  const again = grantOf(vet(session.webRequest, { url: existing, initiatorOrigin: "null", frame: frame(page) }));
  assert.equal((await request(existing, "null", { [GRANT]: again })).status, 200);
  assert.equal(statusOf(await request(existing, "null", { [GRANT]: again })), "refused");
  closeLocalPage(contents);
});

test("a local page loads files from its own folder only, and opens pages elsewhere only on the user's click", async () => {
  const site = path.join(dir, "site");
  const outside = path.join(dir, "outside");
  fs.mkdirSync(path.join(site, "assets"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(site, "assets", "app.js"), "window.app = 1;");
  fs.writeFileSync(path.join(outside, "secret.js"), "window.token = 1;");
  fs.writeFileSync(path.join(outside, "other.html"), "<title>other</title>");
  fs.symlinkSync(outside, path.join(site, "linked"));
  const page = `terminal-browser-file://file${site}/page.html`;
  const contents = await openLocalPage(page);
  const load = async (url, resourceType = "script", sender = frame(page)) => {
    const token = grantOf(vet(session.webRequest, { url, initiatorOrigin: "null", frame: sender, resourceType }));
    return statusOf(await request(url, "null", { [GRANT]: token }));
  };
  assert.equal(await load(`terminal-browser-file://file${site}/assets/app.js`), 200);
  assert.equal(await load(`terminal-browser-file://file${site}/assets/app.js`, "script", frame("about:srcdoc", frame(page))), 200);
  assert.equal(await load(`terminal-browser-file://file${site}/assets/missing.js`), "refused");
  assert.equal(await load(`terminal-browser-file://file${outside}/secret.js`), "refused");
  assert.equal(await load(`terminal-browser-file://file${outside}/missing.js`), "refused");
  assert.equal(await load(`terminal-browser-file://file${site}/assets/..%2F..%2Foutside%2Fsecret.js`), "refused");
  assert.equal(await load(`terminal-browser-file://file${site}/linked/secret.js`), "refused");
  assert.equal(await load(`terminal-browser-file://file${outside}/other.html`, "image"), "refused");
  assert.equal(await load(`terminal-browser-file://file${outside}/other.html`, "mainFrame"), "refused");
  const clicked = { ...frame(page), isDestroyed: () => false, detached: false, documentLifecycle: "active", hasTransientUserActivation: () => true };
  assert.equal(await load(`terminal-browser-file://file${outside}/other.html`, "mainFrame", clicked), 200);
  assert.equal(await load(`terminal-browser-file://file${site}/assets/app.js`, "mainFrame"), 200);
  closeLocalPage(contents);
});

function localSite(name) {
  const site = path.join(dir, name);
  const outside = path.join(dir, `${name}-outside`);
  fs.mkdirSync(site);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "lib.js"), "window.secret = 1;");
  const page = `terminal-browser-file://file${site}/page.html`;
  const load = async (name, range) => {
    const url = `terminal-browser-file://file${site}/${name}`;
    const token = grantOf(vet(session.webRequest, { url, initiatorOrigin: "null", frame: frame(page) }));
    const response = await request(url, "null", { [GRANT]: token, ...(range ? { range } : {}) });
    return { status: statusOf(response), body: response.type === "error" ? "" : await response.text() };
  };
  return { site, outside, page, load };
}

test("a file swapped for a symlink while a local page loads it is never read through the link", async () => {
  const { site, outside, page, load } = localSite("race");
  fs.writeFileSync(path.join(site, "lib.js"), "window.own = 1;");
  const contents = await openLocalPage(page);
  const swapper = require("node:child_process").spawn(process.execPath, [
    "-e",
    `const fs = require("node:fs");
    const [lib, secret] = process.argv.slice(1);
    for (;;) {
      fs.symlinkSync(secret, lib + ".link");
      fs.renameSync(lib + ".link", lib);
      fs.writeFileSync(lib + ".file", "window.own = 1;");
      fs.renameSync(lib + ".file", lib);
    }`,
    path.join(site, "lib.js"),
    path.join(outside, "lib.js"),
  ]);
  try {
    const seen = { own: 0, refused: 0, leaked: 0 };
    for (let i = 0; i < 3000 && seen.leaked === 0; i++) {
      const { status, body } = await load("lib.js");
      if (body.includes("secret")) seen.leaked++;
      else if (status === 200) seen.own++;
      else seen.refused++;
    }
    assert.equal(seen.leaked, 0);
    assert.ok(seen.own > 0 && seen.refused > 0, JSON.stringify(seen));
  } finally {
    swapper.kill("SIGKILL");
    closeLocalPage(contents);
  }
});

test("a local page's folder swapped for a link after the page loaded gives it nothing from the new target", async () => {
  const { site, outside, page, load } = localSite("moved");
  fs.writeFileSync(path.join(site, "own.js"), "window.own = 1;");
  const contents = await openLocalPage(page);
  assert.deepEqual(await load("own.js"), { status: 200, body: "window.own = 1;" });
  fs.renameSync(site, `${site}-away`);
  fs.symlinkSync(outside, site);
  assert.equal((await load("lib.js")).status, "refused");
  closeLocalPage(contents);
});

test("a local page's own files are read once from what was opened: links inside its folder, fifos and ranges", async () => {
  const { site, page, load } = localSite("opened");
  fs.mkdirSync(path.join(site, "real"));
  fs.writeFileSync(path.join(site, "real", "own.js"), "0123456789");
  fs.symlinkSync("real", path.join(site, "inside"));
  fs.symlinkSync("real/own.js", path.join(site, "alias.js"));
  require("node:child_process").execFileSync("mkfifo", [path.join(site, "pipe.js")]);
  const contents = await openLocalPage(page);
  assert.deepEqual(await load("real/own.js"), { status: 200, body: "0123456789" });
  assert.deepEqual(await load("real/own.js", "bytes=2-4"), { status: 206, body: "234" });
  assert.deepEqual(await load("real/own.js", "bytes=-3"), { status: 206, body: "789" });
  assert.equal((await load("inside/own.js")).status, "refused");
  assert.equal((await load("alias.js")).status, "refused");
  assert.equal((await load("pipe.js")).status, "refused");
  assert.equal((await load("real")).status, "refused");
  assert.equal((await load("missing.js")).status, "refused");
  closeLocalPage(contents);
});

test("a hard link in a local page's folder is served only from a folder nobody but the file's owner can write to", async () => {
  const { site, outside, page, load } = localSite("hardlinks");
  fs.mkdirSync(path.join(site, "store"));
  fs.writeFileSync(path.join(site, "store", "pkg.js"), "window.pkg = 1;");
  fs.mkdirSync(path.join(site, "modules"), { mode: 0o755 });
  fs.chmodSync(path.join(site, "modules"), 0o755);
  fs.linkSync(path.join(site, "store", "pkg.js"), path.join(site, "modules", "pkg.js"));
  const drop = path.join(site, "drop");
  fs.mkdirSync(drop);
  fs.chmodSync(drop, 0o777);
  fs.linkSync(path.join(outside, "lib.js"), path.join(drop, "lib.js"));
  fs.writeFileSync(path.join(drop, "own.js"), "window.own = 1;");
  const contents = await openLocalPage(page);
  assert.deepEqual(await load("modules/pkg.js"), { status: 200, body: "window.pkg = 1;" });
  assert.deepEqual(await load("store/pkg.js"), { status: 200, body: "window.pkg = 1;" });
  assert.equal((await load("drop/lib.js")).status, "refused");
  assert.deepEqual(await load("drop/own.js"), { status: 200, body: "window.own = 1;" });
  if (process.platform === "darwin") {
    const acl = path.join(site, "acl");
    fs.mkdirSync(acl, { mode: 0o755 });
    fs.linkSync(path.join(outside, "lib.js"), path.join(acl, "lib.js"));
    require("node:child_process").execFileSync("chmod", ["+a", "everyone allow add_file", acl]);
    assert.equal((await load("acl/lib.js")).status, "refused");
  }
  closeLocalPage(contents);
});

test("a local page that was never served gets none of its folder's files", async () => {
  const { site, page, load } = localSite("unserved");
  fs.writeFileSync(path.join(site, "own.js"), "window.own = 1;");
  const contents = openLocalPageWithoutLoading(page);
  assert.equal((await load("own.js")).status, "refused");
  closeLocalPage(contents);
});

test("a web page can't open a local file in a new tab", () => {
  const { TabManager } = require("../dist/session/tabs.js");
  const opened = [];
  const host = { onActivated() {}, onActiveState() {}, onPageMenu() {}, onTabsChanged() {}, onTabOpened: (_tab, url) => opened.push(url), tabSwitchAllowed: () => true, requestRender() {} };
  const tabs = new TabManager(host, "about:blank");
  tabs.observer = { created() {}, ready() {}, updated() {}, activated() {}, moved() {}, pinned() {}, removed() {} };
  const page = (url, origin) => ({ mainFrame: { framesInSubtree: [{ url, origin, parent: null, isDestroyed: () => false }] } });
  const web = tabs.create("https://evil.example/");
  const local = tabs.create(`terminal-browser-file://file${dir}/page.html`);
  const details = { url: existing, disposition: "foreground-tab", referrer: { url: "" } };
  assert.equal(tabs.openWindow(web.id, details, page("https://evil.example/", "https://evil.example")), "deny");
  assert.deepEqual(opened, []);
  assert.equal(tabs.openWindow(local.id, details, page(`terminal-browser-file://file${dir}/page.html`, "null")), "deny");
  assert.deepEqual(opened, [existing]);
});

class ElectronWebRequest {
  listeners = new Map();
  register(event, filter, listener) {
    if (typeof filter === "function" || filter === null) [filter, listener] = [null, filter];
    if (listener) this.listeners.set(event, { filter, listener });
    else this.listeners.delete(event);
  }
  onBeforeRequest(filter, listener) {
    this.register("beforeRequest", filter, listener);
  }
  onBeforeSendHeaders(listener) {
    this.register("beforeSendHeaders", listener);
  }
  sendHeaders(details) {
    let result;
    this.listeners.get("beforeSendHeaders").listener({ resourceType: "script", requestHeaders: {}, ...details }, (response) => (result = response));
    return result;
  }
  request(details) {
    const found = this.listeners.get("beforeRequest");
    const scheme = details.url.split(":")[0];
    if (!found || (found.filter && !found.filter.urls.some((url) => url.startsWith(`${scheme}:`)))) return {};
    let result;
    found.listener(details, (response) => (result = response));
    return result;
  }
}

test("pixel's file:// guard keeps cancelling xhr while a local page is open and after it closes", () => {
  const pixelDir = path.dirname(require.resolve("@zenbu-labs/pixel/package.json"));
  const { configureBrowserSession } = require(path.join(pixelDir, "dist/web/browser-session.js"));
  const webRequest = new ElectronWebRequest();
  const ses = Object.assign(new electron.FakeSession("guards"), {
    webRequest,
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
  });
  configureBrowserSession(ses);
  const fileXhr = { url: "file:///etc/hosts", resourceType: "xhr", initiatorOrigin: "null", frame: null };
  assert.deepEqual(webRequest.request(fileXhr), { cancel: true });

  const access = new LocalFileAccess(ses);
  const page = frame(`terminal-browser-file://file${dir}/page.html`);
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    mainFrame: { framesInSubtree: [page] },
  });
  access.opening(contents);
  assert.deepEqual(webRequest.request(fileXhr), { cancel: true });
  assert.deepEqual(webRequest.sendHeaders({ url: existing, initiatorOrigin: "null", frame: frame("https://evil.example/") }), { cancel: true });
  assert.ok(grantOf(webRequest.sendHeaders({ url: existing, initiatorOrigin: "null", frame: page })));

  contents.mainFrame.framesInSubtree = [frame("https://example.com/")];
  access.settled(contents);
  assert.deepEqual(webRequest.request(fileXhr), { cancel: true });
});
