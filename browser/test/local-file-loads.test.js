const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const electron = require("./fake-electron.js");
const { servePages } = require("../dist/pages/scheme.js");
const { redirectAllowed, refuseLocalRedirects } = require("../dist/pages/local-loads.js");
const { historyUrl } = require("../dist/browsing/history.js");
const { documentUrl, normalizeUrl } = require("../dist/url.js");

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tb-local-loads-")));
fs.writeFileSync(path.join(dir, "page.html"), "<!doctype html><title>page</title>");
fs.writeFileSync(path.join(dir, "notes.md"), "# notes");
fs.writeFileSync(path.join(dir, "build.log"), "line one\nline two\n");
fs.writeFileSync(path.join(dir, "blob.data"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]));
fs.writeFileSync(path.join(dir, "paper.pdf"), "%PDF-1.4\n");
fs.mkdirSync(path.join(dir, "sub folder"));

const session = electron.session.defaultSession;
servePages(() => ({ cwd: dir, theme: null }));
const webRequest = session.webRequest;
const docHandler = session.protocols.get("terminal-browser-file");
const internalHandler = session.protocols.get("terminal-browser");

function beforeRequest(details) {
  let result;
  webRequest.beforeRequest({ resourceType: "mainFrame", ...details }, (response) => (result = response));
  return result;
}

const fileUrl = (file) => `file://${file}`;
const search = (query) => `https://search.test/?q=${query}`;

test("a local file opens as its sandboxed document wherever it's typed, opened or listed", () => {
  const page = path.join(dir, "page.html");
  assert.equal(normalizeUrl(page, undefined, search), documentUrl(page));
  assert.equal(normalizeUrl("./page.html", dir, search), documentUrl(page));
  assert.equal(normalizeUrl(fileUrl(page), undefined, search), documentUrl(page));
  assert.equal(normalizeUrl(`${fileUrl(page)}?a=1#top`, undefined, search), `${documentUrl(page)}?a=1#top`);
  assert.equal(normalizeUrl(dir, undefined, search), documentUrl(dir));
  assert.equal(normalizeUrl(`${fileUrl(dir)}/`, undefined, search), `${documentUrl(dir)}/`);
  assert.equal(normalizeUrl(path.join(dir, "notes.md"), undefined, search), documentUrl(path.join(dir, "notes.md")));
});

test("history keeps the file:// url of a local document, which opens as the same sandboxed document", () => {
  const page = path.join(dir, "page.html");
  assert.equal(historyUrl(documentUrl(page)), fileUrl(page));
  assert.equal(normalizeUrl(historyUrl(documentUrl(page)), undefined, search), documentUrl(page));
});

test("a page load of a file:// url becomes the sandboxed document for that file", () => {
  const page = path.join(dir, "page.html");
  assert.deepEqual(beforeRequest({ url: fileUrl(page) }), { redirectURL: documentUrl(page) });
  assert.deepEqual(beforeRequest({ url: `${fileUrl(page)}?a=1`, initiatorOrigin: "null" }), { redirectURL: `${documentUrl(page)}?a=1` });
  assert.deepEqual(beforeRequest({ url: "file://elsewhere.example/share/page.html" }), { cancel: true });
});

test("nothing loads from file:// into a file:// or opaque document", () => {
  const secret = fileUrl(path.join(os.homedir(), ".ssh", "id_ed25519"));
  for (const resourceType of ["subFrame", "script", "image", "stylesheet", "media", "other"]) {
    for (const initiatorOrigin of ["null", "file://"]) {
      assert.deepEqual(beforeRequest({ url: secret, resourceType, initiatorOrigin }), { cancel: true }, `${resourceType} from ${initiatorOrigin}`);
    }
  }
  assert.deepEqual(beforeRequest({ url: secret, resourceType: "image", initiatorOrigin: `chrome-extension://${"a".repeat(32)}` }), {});
});

test("a redirect may not lead into our pages or local documents, except a file:// url to its own document", () => {
  const page = path.join(dir, "page.html");
  assert.equal(redirectAllowed("https://evil.test/r", documentUrl(page)), false);
  assert.equal(redirectAllowed("", documentUrl(page)), false);
  assert.equal(redirectAllowed("https://evil.test/r", "terminal-browser://settings/"), false);
  assert.equal(redirectAllowed("https://evil.test/r", "TERMINAL-BROWSER://extensions/"), false);
  assert.equal(redirectAllowed(fileUrl(path.join(dir, "other.html")), documentUrl(page)), false);
  assert.equal(redirectAllowed(fileUrl(page), documentUrl(page)), true);
  assert.equal(redirectAllowed(`${fileUrl(dir)}/`, `${documentUrl(dir)}/`), true);
  assert.equal(redirectAllowed("terminal-browser://start/", "terminal-browser://newtab/"), true);
  assert.equal(redirectAllowed("http://a.test/", "https://a.test/"), true);
});

test("every request a redirect sent into a local document or our page is cancelled, once", () => {
  const page = documentUrl(path.join(dir, "page.html"));
  for (const target of [page, "terminal-browser://extensions/"]) {
    webRequest.beforeRedirect({ url: "https://evil.test/r", redirectURL: target, resourceType: "other" });
    assert.deepEqual(beforeRequest({ url: target, resourceType: "other" }), { cancel: true }, target);
    assert.deepEqual(beforeRequest({ url: target, resourceType: "other" }), {}, `${target} loaded again by the browser`);
  }
  webRequest.beforeRedirect({ url: fileUrl(path.join(dir, "page.html")), redirectURL: page, resourceType: "mainFrame" });
  assert.deepEqual(beforeRequest({ url: page }), {});
});

test("a navigation a server redirects into a local document or our page is stopped in every web contents", () => {
  const contents = Object.assign(new EventEmitter(), { session });
  refuseLocalRedirects(contents);
  const frame = { frameTreeNodeId: 7 };
  const redirect = (url) => {
    let prevented = false;
    contents.emit("will-redirect", { url, frame, isMainFrame: true, preventDefault: () => (prevented = true) });
    return prevented;
  };
  const page = path.join(dir, "page.html");
  contents.emit("did-start-navigation", { url: "https://evil.test/r", frame, isMainFrame: true });
  assert.equal(redirect(documentUrl(page)), true);
  assert.equal(redirect("terminal-browser://settings/"), true);
  assert.equal(redirect("https://elsewhere.test/"), false);
  assert.equal(redirect(documentUrl(page)), true);
  contents.emit("did-start-navigation", { url: fileUrl(page), frame, isMainFrame: true });
  assert.equal(redirect(documentUrl(page)), false);
});

test("our pages and local documents still serve the browser's own loads", async () => {
  assert.equal((await internalHandler({ url: "terminal-browser://start/", headers: new Headers() })).status, 200);
  assert.equal((await docHandler({ url: documentUrl(path.join(dir, "page.html")), headers: new Headers() })).status, 200);
});

test("a local folder is listed as a sandboxed document linking to the local documents in it", async () => {
  const response = await docHandler({ url: documentUrl(dir), headers: new Headers() });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/html/);
  assert.match(response.headers.get("content-security-policy"), /^sandbox /);
  assert.match(response.headers.get("content-security-policy"), /script-src 'none'/);
  const body = await response.text();
  assert.ok(body.includes(`href="${documentUrl(path.join(dir, "page.html"))}"`), body);
  assert.ok(body.includes(`href="${documentUrl(path.join(dir, "sub folder"))}"`), body);
  assert.ok(body.includes(`href="${documentUrl(path.dirname(dir))}"`), body);
  assert.ok(!body.includes(`href="file:`), body);
});

test("a local file is served with the type Chromium's file:// loader would give it", async () => {
  const type = async (name) => (await docHandler({ url: documentUrl(path.join(dir, name)), headers: new Headers() })).headers.get("content-type");
  assert.equal(await type("paper.pdf"), "application/pdf");
  assert.equal(await type("build.log"), "text/plain; charset=utf-8");
  assert.equal(await type("blob.data"), "application/octet-stream");
  assert.equal(await type("page.html"), "text/html; charset=utf-8");
});
