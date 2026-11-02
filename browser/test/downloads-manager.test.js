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
  // Stands in for Chromium: it writes to whatever save path it was given,
  // following symlinks like a plain open does.
  downloadURL(url) {
    defaultSession.requested.push(url);
    const item = Object.assign(new EventEmitter(), {
      savePath: "",
      getURLChain: () => [url],
      getURL: () => url,
      getStartTime: () => 0,
      getMimeType: () => "text/plain",
      getTotalBytes: () => 14,
      getReceivedBytes: () => 14,
      getFilename: () => "payload.txt",
      setSavePath: (file) => (item.savePath = file),
      getSavePath: () => item.savePath,
    });
    defaultSession.emit("will-download", { defaultPrevented: false }, item);
    setImmediate(() => {
      fs.writeFileSync(item.savePath, "hello download");
      item.emit("done", {}, "completed");
    });
  },
});
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") {
    return {
      app: { on() {}, getPath: () => folder },
      session: { defaultSession },
      shell: {},
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
    };
  }
  return load.call(this, request, ...rest);
};

const { DownloadManager } = require("../dist/browsing/downloads.js");

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
    started = new DownloadManager();
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
