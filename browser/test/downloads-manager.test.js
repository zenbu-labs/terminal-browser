const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { test } = require("node:test");

let folder = "";
const rows = new Map();
let nextId = 1;
const { EventEmitter } = require("node:events");
const defaultSession = Object.assign(new EventEmitter(), {
  fetch: async () => new Response("hello download", { headers: { "content-type": "text/plain" } }),
  requested: [],
  downloadURL(url) {
    defaultSession.requested.push(url);
    startItem(url);
  },
});

// Stands in for Chromium: it writes to whatever save path it was given,
// following symlinks like a plain open does.
function startItem(url, { filename = "payload.txt", gesture = false, contents, initiator = "" } = {}) {
  const item = Object.assign(new EventEmitter(), {
    savePath: "",
    getURLChain: () => [url],
    getURL: () => url,
    getStartTime: () => 0,
    getMimeType: () => "text/plain",
    getTotalBytes: () => 14,
    getReceivedBytes: () => 14,
    getFilename: () => filename,
    hasUserGesture: () => gesture,
    getInitiatorOrigin: () => initiator,
    setSavePath: (file) => (item.savePath = file),
    getSavePath: () => item.savePath,
    cancel() {},
  });
  defaultSession.emit("will-download", { defaultPrevented: false }, item, contents);
  setImmediate(() => {
    fs.writeFileSync(item.savePath, "hello download");
    item.emit("done", {}, "completed");
  });
  return item;
}

const fakeApp = { on() {}, getPath: () => folder, getName: () => "terminal-browser" };
const firstVisits = new Map();
const shell = {
  revealed: [],
  opened: [],
  showItemInFolder: (file) => shell.revealed.push(file),
  openPath: async (file) => (shell.opened.push(file), ""),
};
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") {
    return {
      app: fakeApp,
      session: { defaultSession },
      shell,
    };
  }
  if (request === "shared") {
    return {
      createDownload: (record) => {
        const row = { ...record, id: nextId++ };
        rows.set(row.id, row);
        return row;
      },
      updateDownload: (id, record) => rows.set(id, { ...record, id }),
      getDownload: (id) => rows.get(id) ?? null,
      listDownloads: () => [...rows.values()],
      deleteDownload: (id) => rows.delete(id),
      interruptStaleDownloads() {},
      firstVisitToOrigin: (origin) => firstVisits.get(origin) ?? null,
    };
  }
  return load.call(this, request, ...rest);
};

const { DownloadManager } = require("../dist/browsing/downloads.js");
const { navigateTyped, openedFromAddressBar, takeTypedDownload, watchTypedNavigations } = require("../dist/browsing/typed.js");
const { quarantined } = require("@zenbu-labs/pixel/native");

function finished(manager, id) {
  return new Promise((resolve) => {
    manager.changed.add((record) => {
      if (record.id === id && record.state !== "in_progress") resolve(record);
    });
  });
}

test("a POST download whose file can't be written ends interrupted instead of crashing", async (t) => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "tb-dl-"));
  fs.chmodSync(folder, 0o500);
  t.after(() => {
    fs.chmodSync(folder, 0o700);
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const manager = new DownloadManager();
  const done = finished(manager, nextId);
  await manager.download({ url: "https://a.test/form", method: "POST", body: "x=1", extensionId: null, allowFileAccess: false });
  const record = await done;
  assert.equal(record.state, "interrupted");
  assert.equal(record.error, "FILE_FAILED");
});

test("a POST download lands under the name an extension chose", async (t) => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "tb-dl-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const manager = new DownloadManager();
  manager.determiner = async () => ({ filename: "chosen/name.txt", conflictAction: "uniquify" });
  const id = await manager.download({ url: "https://a.test/form", method: "POST", body: "x=1", extensionId: "ext", allowFileAccess: false });
  const record = await finished(manager, id);
  assert.equal(record.state, "complete");
  assert.equal(record.filename, path.join(folder, "chosen/name.txt"));
  assert.equal(record.mime, "text/plain");
  assert.equal(fs.readFileSync(record.filename, "utf8"), "hello download");
});

test("downloads.download refuses file names outside the downloads folder", async () => {
  const manager = new DownloadManager();
  await assert.rejects(manager.download({ url: "https://a.test/f", filename: "../escape.txt", extensionId: null, allowFileAccess: false }), { message: "Invalid filename" });
});

function attackerSetup(t) {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "tb-dl-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tb-dl-outside-"));
  t.after(() => {
    fs.rmSync(folder, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const victim = path.join(outside, "bashrc");
  fs.writeFileSync(victim, "original");
  fs.symlinkSync(victim, path.join(folder, "payload.txt"));
  fs.symlinkSync(outside, path.join(folder, "linked"));
  fs.symlinkSync(path.join(outside, "created-through-link"), path.join(folder, "dangling.txt"));
  return { manager: startedManager(), outside, victim };
}

let started = null;
function startedManager() {
  if (!started) {
    started = new DownloadManager(takeTypedDownload);
    started.start();
  }
  return started;
}

const extensionRequest = (extra) => ({ extensionId: "ext", allowFileAccess: false, ...extra });

for (const [label, extra] of [
  ["a POST download", { url: "https://a.test/payload.txt", method: "POST", body: "x=1" }],
  ["a regular download", { url: "https://a.test/payload.txt" }],
]) {
  test(`${label} never writes through a symlink in the downloads folder`, async (t) => {
    const { manager, outside, victim } = attackerSetup(t);
    for (const [filename, conflictAction] of [
      ["payload.txt", "overwrite"],
      ["payload.txt", "uniquify"],
      ["linked/payload.txt", "overwrite"],
      ["linked/new.txt", "uniquify"],
      ["dangling.txt", "uniquify"],
      ["dangling.txt", "overwrite"],
    ]) {
      const done = finished(manager, nextId);
      await manager.download(extensionRequest({ ...extra, filename, conflictAction }));
      const record = await done;
      assert.equal(record.state, "complete", `${filename} ${conflictAction}`);
      assert.equal(path.relative(folder, record.filename).startsWith(".."), false, record.filename);
      assert.equal(fs.lstatSync(record.filename).isSymbolicLink(), false, record.filename);
      assert.equal(fs.readFileSync(record.filename, "utf8"), "hello download");
    }
    assert.equal(fs.readFileSync(victim, "utf8"), "original");
    assert.deepEqual(fs.readdirSync(outside), ["bashrc"]);
    assert.deepEqual(fs.readdirSync(folder).filter((name) => name.endsWith(".crdownload")), []);
  });
}

// Once the bytes are written, the download looks at `dir` twice (does it exist,
// is it a real folder); right after that check this swaps `dir` for a symlink
// to `outside`, the moment a racing local writer would.
function swapAfterFinalCheck(t, dir, outside) {
  const lstatSync = fs.lstatSync;
  let swapped = false;
  let checks = 0;
  fs.lstatSync = function (file, ...rest) {
    const stat = lstatSync.call(fs, file, ...rest);
    const written = fs.readdirSync(folder).some((name) => name.endsWith(".crdownload") && fs.statSync(path.join(folder, name)).size > 0);
    if (!swapped && file === dir && written && ++checks === 2) {
      swapped = true;
      fs.renameSync(dir, `${dir}-moved`);
      fs.symlinkSync(outside, dir);
    }
    return stat;
  };
  t.after(() => (fs.lstatSync = lstatSync));
  return () => swapped;
}

for (const [label, extra] of [
  ["a POST download", { url: "https://a.test/payload.txt", method: "POST", body: "x=1" }],
  ["a regular download", { url: "https://a.test/payload.txt" }],
]) {
  test(`${label} can't be led outside the downloads folder by a folder swapped for a symlink after its checks`, async (t) => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), "tb-dl-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tb-dl-outside-"));
    t.after(() => {
      fs.rmSync(folder, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    });
    const swapped = swapAfterFinalCheck(t, path.join(folder, "sub"), outside);
    const manager = startedManager();
    const done = finished(manager, nextId);
    await manager.download(extensionRequest({ ...extra, filename: "sub/payload.txt", conflictAction: "uniquify" }));
    const record = await done;
    assert.equal(swapped(), true);
    assert.deepEqual(fs.readdirSync(outside), []);
    if (extra.method === "POST") {
      assert.deepEqual([record.state, record.error], ["interrupted", "FILE_FAILED"]);
    } else {
      assert.equal(record.state, "complete");
      assert.equal(path.dirname(fs.realpathSync(record.filename)), fs.realpathSync(folder), record.filename);
      assert.equal(fs.readFileSync(record.filename, "utf8"), "hello download");
    }
  });
}

test("an extension without file access can't download file: URLs, like Chrome", async (t) => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "tb-dl-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const manager = startedManager();
  defaultSession.requested.length = 0;
  let fetched = 0;
  const fetch = defaultSession.fetch;
  defaultSession.fetch = async (...args) => (fetched++, fetch(...args));
  t.after(() => (defaultSession.fetch = fetch));
  for (const extra of [{}, { method: "POST", body: "x" }]) {
    const done = finished(manager, nextId);
    const id = await manager.download(extensionRequest({ url: `file://${__filename}`, ...extra }));
    assert.equal(typeof id, "number");
    const record = await done;
    assert.equal(record.state, "interrupted");
    assert.equal(record.error, "NETWORK_INVALID_REQUEST");
    assert.equal(record.receivedBytes, 0);
  }
  assert.deepEqual(defaultSession.requested, []);
  assert.equal(fetched, 0);
  const allowed = finished(manager, nextId);
  await manager.download(extensionRequest({ url: `file://${__filename}`, allowFileAccess: true }));
  assert.equal((await allowed).state, "complete");
  assert.deepEqual(defaultSession.requested, [`file://${__filename}`]);
});

const unconfirmed = () => fs.readdirSync(folder).filter((name) => name.endsWith(".crdownload"));

// A dangerous download is held once its bytes sit, marked, under their unconfirmed name.
async function heldDownload(manager, id) {
  for (let tries = 0; tries < 500; tries++) {
    const record = manager.get(id);
    const [waiting] = unconfirmed();
    const written = waiting && fs.statSync(path.join(folder, waiting)).size === 14;
    if (record?.state !== "in_progress") return record;
    if (record.danger === "file" && written && quarantined(path.join(folder, waiting)) !== false) return record;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("download was never held");
}

function freshFolder(t) {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "tb-dl-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
}

const macOnly = { skip: process.platform !== "darwin" && "quarantine is macOS only" };

for (const [label, extra] of [
  ["a POST download", { url: "https://a.test/f", method: "POST", body: "x=1" }],
  ["a regular download", { url: "https://a.test/f" }],
]) {
  test(`${label} of a type that can run code is held unconfirmed and quarantined until the user keeps it`, async (t) => {
    freshFolder(t);
    const manager = startedManager();
    const id = await manager.download(extensionRequest({ ...extra, filename: "Report.sh" }));
    const record = await heldDownload(manager, id);
    assert.deepEqual([record.state, record.danger], ["in_progress", "file"]);
    assert.equal(record.filename, path.join(folder, "Report.sh"));
    assert.equal(fs.existsSync(record.filename), false);
    const [waiting] = unconfirmed();
    if (process.platform === "darwin") assert.equal(quarantined(path.join(folder, waiting)), true);
    assert.deepEqual(fs.readdirSync(folder), [waiting]);
    assert.throws(() => manager.open(id), { message: "Download must be complete" });
    manager.accept(id);
    const kept = manager.get(id);
    assert.deepEqual([kept.state, kept.danger], ["complete", "accepted"]);
    assert.equal(fs.readFileSync(kept.filename, "utf8"), "hello download");
    if (process.platform === "darwin") assert.equal(quarantined(kept.filename), true);
    assert.deepEqual(unconfirmed(), []);
    assert.equal(manager.opensOnlyAfterPrompt(id), true);
  });

  test(`${label} the user discards leaves nothing behind`, async (t) => {
    freshFolder(t);
    const manager = startedManager();
    const id = await manager.download(extensionRequest({ ...extra, filename: "Report.sh" }));
    await heldDownload(manager, id);
    manager.discard(id);
    assert.equal(manager.get(id), null);
    assert.deepEqual(fs.readdirSync(folder), []);
  });
}

test("every finished download is quarantined with where it came from", macOnly, async (t) => {
  freshFolder(t);
  const manager = startedManager();
  for (const extra of [{ url: "https://user:pw@a.test/notes.txt" }, { url: "https://a.test/form", method: "POST", body: "x" }]) {
    const id = await manager.download(extensionRequest({ ...extra, filename: `${nextId}.txt` }));
    const record = await finished(manager, id);
    assert.deepEqual([record.state, record.danger], ["complete", "safe"]);
    const flag = require("node:child_process").execFileSync("xattr", ["-p", "com.apple.quarantine", record.filename], { encoding: "utf8" });
    assert.match(flag, /^[0-9a-f]{4};[0-9a-f]+;terminal-browser;[0-9A-F-]{36}\n$/);
    const from = require("node:child_process").execFileSync("xattr", ["-p", "com.apple.metadata:kMDItemWhereFroms", record.filename]);
    assert.equal(from.includes("user:pw"), false);
    assert.equal(manager.opensOnlyAfterPrompt(id), false);
  }
});

test("a file that can't be quarantined on macOS fails the download instead of completing unmarked", macOnly, async (t) => {
  freshFolder(t);
  const manager = startedManager();
  fakeApp.getName = () => {
    throw new Error("no name");
  };
  t.after(() => (fakeApp.getName = () => "terminal-browser"));
  for (const extra of [{ url: "https://a.test/f" }, { url: "https://a.test/form", method: "POST", body: "x" }]) {
    const id = await manager.download(extensionRequest({ ...extra, filename: "notes.txt" }));
    const record = await finished(manager, id);
    assert.deepEqual([record.state, record.error], ["interrupted", "FILE_SECURITY_CHECK_FAILED"]);
  }
  assert.deepEqual(fs.readdirSync(folder), []);
});

test("keeping a held download never replaces a file that took its name meanwhile", async (t) => {
  freshFolder(t);
  const manager = startedManager();
  const id = await manager.download(extensionRequest({ url: "https://a.test/f", filename: "Report.sh" }));
  await heldDownload(manager, id);
  fs.writeFileSync(path.join(folder, "Report.sh"), "someone else's");
  manager.accept(id);
  const kept = manager.get(id);
  assert.equal(kept.filename, path.join(folder, "Report (1).sh"));
  assert.equal(fs.readFileSync(path.join(folder, "Report.sh"), "utf8"), "someone else's");
  assert.equal(fs.readFileSync(kept.filename, "utf8"), "hello download");
});

test("a page download of a risky type is dangerous unless the click came from a site visited before today", async (t) => {
  freshFolder(t);
  const manager = startedManager();
  const contents = fakeTab("https://site.test/page");
  const run = (options) => pageDownload(manager, "https://site.test/run.sh", { contents, initiator: "https://site.test", ...options });
  firstVisits.clear();
  assert.equal((await run({ gesture: true })).danger, "file");
  firstVisits.set("https://site.test", TWO_DAYS_AGO);
  assert.equal((await run({ gesture: false })).danger, "file");
  const safe = await run({ gesture: true });
  assert.deepEqual([safe.state, safe.danger], ["complete", "safe"]);
  firstVisits.clear();
});

const TWO_DAYS_AGO = Date.now() - 2 * 24 * 60 * 60 * 1000;
let nextTab = 100;

// A tab with Chromium's main-frame navigation events, watched for typed navigations like every real tab.
function fakeTab(url) {
  const contents = Object.assign(new EventEmitter(), { id: nextTab++, isDestroyed: () => false, getURL: () => url });
  contents.start = (next, initiator) => contents.emit("did-start-navigation", { url: next, isMainFrame: true, isSameDocument: false, initiator });
  contents.commit = (next) => {
    url = next;
    contents.emit("did-navigate", {}, next);
  };
  contents.type = (next) => navigateTyped(contents, () => contents.start(next));
  watchTypedNavigations(contents);
  return contents;
}

async function pageDownload(manager, url, options) {
  const created = new Promise((resolve) => {
    const stop = manager.created.add((record) => {
      stop();
      resolve(record.id);
    });
  });
  startItem(url, { filename: path.posix.basename(new URL(url).pathname), ...options });
  const id = await created;
  const record = await heldDownload(manager, id);
  if (record.state === "in_progress") manager.discard(id);
  return record;
}

test("a download is from the address bar only when it is the typed navigation itself, through its redirects", async (t) => {
  freshFolder(t);
  const manager = startedManager();
  firstVisits.clear();
  const tab = fakeTab("https://old.test/");
  tab.type("https://typed.test/Installer.pkg");
  assert.equal((await pageDownload(manager, "https://typed.test/Installer.pkg", { contents: tab })).danger, "safe");
  assert.equal((await pageDownload(manager, "https://typed.test/Installer.pkg", { contents: tab })).danger, "file", "one navigation, one download");

  tab.type("https://typed.test/go");
  tab.emit("did-redirect-navigation", { url: "https://cdn.typed.test/Installer.pkg", isMainFrame: true });
  const redirected = await pageDownload(manager, "https://typed.test/go", { contents: tab });
  assert.equal(redirected.danger, "safe", "Chrome keeps the transition through the download's redirects");
});

test("a typed URL that redirected to a page lends nothing to that page's own downloads", async (t) => {
  freshFolder(t);
  const manager = startedManager();
  const tab = fakeTab("https://old.test/");
  tab.type("https://evil.test/");
  tab.commit("https://evil.test/home");
  const script = await pageDownload(manager, "https://evil.test/", { contents: tab, initiator: "https://evil.test", filename: "Installer.pkg" });
  assert.equal(script.danger, "file");
  const browserStarted = await pageDownload(manager, "https://evil.test/", { contents: tab, filename: "Installer.pkg" });
  assert.equal(browserStarted.danger, "file");
});

test("a typed navigation lends nothing to other tabs, to the page it replaces, or once another navigation starts", async (t) => {
  freshFolder(t);
  const manager = startedManager();
  const typedTab = fakeTab("https://old.test/");
  const other = fakeTab("https://evil.test/page");
  typedTab.type("https://evil.test/Installer.pkg");
  assert.equal((await pageDownload(manager, "https://evil.test/Installer.pkg", { contents: other })).danger, "file", "another tab");
  assert.equal((await pageDownload(manager, "https://evil.test/Installer.pkg", { contents: other, initiator: "https://evil.test" })).danger, "file", "another tab's script");
  assert.equal((await pageDownload(manager, "https://evil.test/Installer.pkg", { contents: typedTab, initiator: "https://old.test" })).danger, "file", "the old page's script");
  typedTab.start("https://evil.test/next", "https://old.test");
  assert.equal((await pageDownload(manager, "https://evil.test/Installer.pkg", { contents: typedTab })).danger, "file", "a later navigation");
});

test("the first page of a tab opened from the address bar is typed; other new tabs aren't", async (t) => {
  freshFolder(t);
  const manager = startedManager();
  const typedTab = fakeTab("");
  typedTab.start("https://a.test/Installer.pkg");
  openedFromAddressBar(typedTab);
  assert.equal((await pageDownload(manager, "https://a.test/Installer.pkg", { contents: typedTab })).danger, "safe");
  const linkTab = fakeTab("");
  linkTab.start("https://a.test/Installer.pkg");
  assert.equal((await pageDownload(manager, "https://a.test/Installer.pkg", { contents: linkTab })).danger, "file");
  typedTab.commit("https://a.test/");
  typedTab.start("https://a.test/Installer.pkg");
  assert.equal((await pageDownload(manager, "https://a.test/Installer.pkg", { contents: typedTab })).danger, "file", "only its first navigation");
});

test("the visited-before-today check uses the site that started the download, like Chrome's referrer", async (t) => {
  freshFolder(t);
  const manager = startedManager();
  firstVisits.clear();
  firstVisits.set("https://news.test", TWO_DAYS_AGO);
  const visitedTop = fakeTab("https://news.test/article");
  const adFrame = await pageDownload(manager, "https://ads.test/Update.dmg", { contents: visitedTop, initiator: "https://ads.test", gesture: true });
  assert.equal(adFrame.danger, "file", "a never-visited iframe in a visited page");
  const newTop = fakeTab("https://new.test/");
  const visitedFrame = await pageDownload(manager, "https://news.test/Update.dmg", { contents: newTop, initiator: "https://news.test", gesture: true });
  assert.equal(visitedFrame.danger, "safe", "a visited site's iframe in a new page");
  for (const initiator of ["chrome-extension://abcdefghijklmnopabcdefghijklmnop", "null", ""]) {
    const record = await pageDownload(manager, "https://news.test/Update.dmg", { contents: visitedTop, initiator, gesture: true });
    assert.equal(record.danger, "file", `initiator ${JSON.stringify(initiator)}`);
  }
  firstVisits.clear();
});

test("showing a download or the downloads folder only ever reveals, never opens", async (t) => {
  freshFolder(t);
  const manager = startedManager();
  shell.revealed.length = 0;
  shell.opened.length = 0;
  fs.mkdirSync(path.join(folder, "Some.app"));
  const id = await manager.download(extensionRequest({ url: "https://a.test/f", filename: "Some.app/x.pkg" }));
  const held = await heldDownload(manager, id);
  assert.equal(fs.existsSync(held.filename), false);
  manager.show(id);
  manager.showDefaultFolder();
  const done = finished(manager, nextId);
  const plain = await manager.download(extensionRequest({ url: "https://a.test/f", filename: "notes.txt" }));
  await done;
  manager.show(plain);
  assert.deepEqual(shell.opened, []);
  assert.deepEqual(shell.revealed, [path.join(folder, "Some.app"), folder, path.join(folder, "notes.txt")]);
  manager.discard(id);
});
