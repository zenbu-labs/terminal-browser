const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { test } = require("node:test");

let folder = "";
const rows = new Map();
let nextId = 1;
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") {
    return {
      app: { on() {}, getPath: () => folder },
      session: { defaultSession: { fetch: async () => new Response("hello download", { headers: { "content-type": "text/plain" } }) } },
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
  const id = await manager.download({ url: "https://a.test/form", method: "POST", body: "x=1", extensionId: null });
  const record = await finished(manager, id);
  assert.equal(record.state, "interrupted");
  assert.equal(record.error, "FILE_FAILED");
});

test("a POST download lands under the name an extension chose", async (t) => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "tb-dl-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const manager = new DownloadManager();
  manager.determiner = async () => ({ filename: "chosen/name.txt", conflictAction: "uniquify" });
  const id = await manager.download({ url: "https://a.test/form", method: "POST", body: "x=1", extensionId: "ext" });
  const record = await finished(manager, id);
  assert.equal(record.state, "complete");
  assert.equal(record.filename, path.join(folder, "chosen/name.txt"));
  assert.equal(record.mime, "text/plain");
  assert.equal(fs.readFileSync(record.filename, "utf8"), "hello download");
});

test("downloads.download refuses file names outside the downloads folder", async () => {
  const manager = new DownloadManager();
  await assert.rejects(manager.download({ url: "https://a.test/f", filename: "../escape.txt", extensionId: null }), { message: "Invalid filename" });
});
