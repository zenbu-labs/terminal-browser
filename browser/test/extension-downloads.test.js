const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

// chrome.downloads as an attacker extension would call it: the handlers run
// against a fake download manager, so nothing touches the real disk or shell.
const opened = [];
const erased = [];
const accepted = [];
const records = new Map();
const manager = {
  determiner: null,
  created: listeners(),
  changed: listeners(),
  erased: listeners(),
  get: (id) => records.get(id) ?? null,
  list: () => [...records.values()],
  canResume: () => false,
  remainingMs: () => null,
  open: (id) => opened.push(id),
  opensOnlyAfterPrompt: (id) => opensOnlyAfterPrompt(records.get(id).filename, records.get(id).danger),
  accept: (id) => {
    accepted.push(id);
    records.set(id, { ...records.get(id), state: "complete", danger: "accepted" });
  },
  discard: (id) => manager.erase(id),
  erase: (id) => {
    erased.push(id);
    records.delete(id);
  },
  download: async () => 99,
};

function listeners() {
  const set = new Set();
  return { add: (fn) => set.add(fn), emit: (...args) => [...set].forEach((fn) => fn(...args)) };
}

// The page the extension's popup runs in; a click in it counts as recent input.
const popupPage = new EventEmitter();

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") {
    return {
      app: { on() {}, getPath: () => "/tmp", getFileIcon: async () => ({ toDataURL: () => "data:" }) },
      ipcMain: { handle() {}, on() {} },
      webContents: { getAllWebContents: () => [popupPage] },
      session: {},
      shell: {},
    };
  }
  if (request === "shared") return {};
  if (request === "../../browsing") return { browsing: () => ({ downloads: manager }) };
  if (request === "../action") return { extensionIcon: () => null };
  return load.call(this, request, ...rest);
};

const { installDownloads, downloadDelta, checkDownloadHeaders } = require("../dist/extensions/api/downloads.js");
const { opensOnlyAfterPrompt } = require("../dist/browsing/download-danger.js");
const { listenForUserActivation } = require("../dist/extensions/user-activation.js");
const { safeRelativeFilename } = require("../dist/browsing/downloads.js");
const { mimeForFile } = require("../dist/browsing/mime.js");

function extension(id, { permissions = ["downloads"], gesture = false, installedAt = 1 } = {}) {
  return {
    id,
    name: id,
    record: { installedAt },
    hasApiPermission: (permission) => permissions.includes(permission),
    hadRecentUserGesture: () => gesture,
  };
}

function setup() {
  opened.length = 0;
  erased.length = 0;
  records.clear();
  manager.determiner = null;
  const handlers = new Map();
  const dispatched = [];
  const prompts = [];
  let promptAnswer = false;
  const listening = new Map();
  const service = {
    loaded: new Map(),
    router: { handle: (name, run) => handlers.set(name, run) },
    events: {
      hasListener: (id, event) => listening.get(id)?.has(event) ?? false,
      listenerRemoved: { add() {} },
    },
    broadcast(event, argsFor) {
      for (const ext of service.loaded.values()) {
        if (!service.events.hasListener(ext.id, event)) continue;
        const args = argsFor(ext);
        if (args) dispatched.push({ to: ext.id, event, args });
      }
    },
    dispatch: (to, event, args) => dispatched.push({ to, event, args }),
    get: (id) => service.loaded.get(id) ?? null,
    currentWindow: () => ({
      host: {
        prompt: async (request) => {
          prompts.push(request);
          return promptAnswer;
        },
      },
    }),
  };
  installDownloads(service);
  const call = (name, caller, ...args) => Promise.resolve().then(() => handlers.get(name)(caller, ...args));
  return {
    service,
    call,
    dispatched,
    prompts,
    listen: (id, event) => listening.set(id, new Set([...(listening.get(id) ?? []), event])),
    answerPrompt: (answer) => (promptAnswer = answer),
  };
}

function complete(id, filename = "/tmp/tb-test-download-missing.txt") {
  const record = { id, url: "https://a.test/f", finalUrl: "https://a.test/f", filename, mime: "text/plain", startTime: 1, endTime: 2, state: "complete", error: null, paused: false, totalBytes: 5, receivedBytes: 5, byExtensionId: null, danger: "safe" };
  records.set(id, record);
  return record;
}

const worker = (ext) => ({ kind: "worker", extension: ext });

listenForUserActivation();

// A call from the extension's popup right after the user clicked in it.
function clickedPopup(ext) {
  popupPage.emit("input-event", {}, { type: "mouseDown" });
  const frame = { isDestroyed: () => false, detached: false, documentLifecycle: "active", hasTransientUserActivation: () => true };
  return { kind: "frame", extension: ext, contents: popupPage, frame };
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tb-ext-dl-"));
process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));

function fileNamed(name) {
  const file = path.join(fs.mkdtempSync(path.join(scratch, "f-")), name);
  fs.writeFileSync(file, "echo harmless");
  return file;
}

test("downloads.open from a service worker without a user gesture is refused and opens nothing", async () => {
  const { call } = setup();
  complete(1, __filename);
  const attacker = extension("attacker", { permissions: ["downloads", "downloads.open"] });
  await assert.rejects(call("downloads.open", worker(attacker), 1), { message: "User gesture required" });
  assert.deepEqual(opened, []);
});

test("downloads.open checks the id before anything else, like Chrome", async () => {
  const { call } = setup();
  const attacker = extension("attacker", { permissions: ["downloads", "downloads.open"] });
  await assert.rejects(call("downloads.open", worker(attacker), 404), { message: "Invalid downloadId" });
});

test("downloads.open needs the downloads.open permission even with a gesture", async () => {
  const { call } = setup();
  complete(1, __filename);
  const ext = extension("ext", { gesture: true });
  await assert.rejects(call("downloads.open", worker(ext), 1), { message: 'The "downloads.open" permission is required' });
  assert.deepEqual(opened, []);
});

test("downloads.open from a worker with a gesture still asks the user first", async () => {
  const { call, prompts, answerPrompt } = setup();
  complete(1, __filename);
  const ext = extension("ext", { permissions: ["downloads", "downloads.open"], gesture: true });
  answerPrompt(false);
  await assert.rejects(call("downloads.open", worker(ext), 1), { message: 'The "downloads.open" permission is required' });
  assert.equal(prompts.length, 1);
  assert.deepEqual(opened, []);
  answerPrompt(true);
  await call("downloads.open", worker(ext), 1);
  assert.deepEqual(opened, [1]);
});

test("downloads.open refuses unfinished and deleted downloads", async () => {
  const { call } = setup();
  const ext = extension("ext", { permissions: ["downloads", "downloads.open"], gesture: true });
  complete(1, "/tmp/tb-test-download-that-does-not-exist");
  await assert.rejects(call("downloads.open", worker(ext), 1), { message: "Download file already deleted" });
  records.set(2, { ...complete(2), state: "in_progress" });
  await assert.rejects(call("downloads.open", worker(ext), 2), { message: "Download must be complete" });
  assert.deepEqual(opened, []);
});

test("downloads.download refuses headers Chrome treats as unsafe", () => {
  for (const name of ["Cookie", "cookie2", "Origin", "Referer", "Host", "Sec-Fetch-Site", "Proxy-Authorization", "User-Agent"]) {
    assert.throws(() => checkDownloadHeaders([{ name, value: "x" }]), { message: "Unsafe request header name" }, name);
  }
  assert.throws(() => checkDownloadHeaders([{ name: "bad name", value: "x" }]), { message: "Invalid request header name" });
  assert.throws(() => checkDownloadHeaders([{ name: "X-Ok", value: "a\r\nInjected: 1" }]), { message: "Invalid request header value" });
  assert.deepEqual(checkDownloadHeaders([{ name: "X-Ok", value: "1" }]), { "X-Ok": "1" });
  assert.equal(checkDownloadHeaders(undefined), undefined);
});

test("suggested download names can't escape the downloads folder", () => {
  for (const bad of ["../escape.txt", "/etc/passwd", "a/../../b.txt", "a\\..\\..\\b.txt", "", "dir/", "./x"]) {
    assert.equal(safeRelativeFilename(bad), null, bad);
  }
  assert.equal(safeRelativeFilename("sub/name.txt"), "sub/name.txt");
  assert.equal(safeRelativeFilename("sub\\name.txt"), "sub/name.txt");
});

test("downloads.acceptDanger from a worker removes the download like Chrome", async () => {
  const { call } = setup();
  complete(7);
  await call("downloads.acceptDanger", worker(extension("ext")), 7);
  assert.deepEqual(erased, [7]);
});

test("onDeterminingFilename: the most recently installed extension wins and each may answer once", async () => {
  const { service, call, dispatched, listen } = setup();
  const older = extension("older", { installedAt: 1 });
  const newer = extension("newer", { installedAt: 2 });
  const outsider = extension("outsider", { installedAt: 3 });
  for (const ext of [older, newer, outsider]) service.loaded.set(ext.id, ext);
  listen("older", "downloads.onDeterminingFilename");
  listen("newer", "downloads.onDeterminingFilename");
  const record = { ...complete(5), state: "in_progress", filename: "" };
  records.set(5, record);
  const decided = manager.determiner(record, "/tmp/dl/server-name.txt");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    dispatched.filter((d) => d.event === "downloads.onDeterminingFilename").map((d) => [d.to, d.args[0].filename]),
    [
      ["older", "/tmp/dl/server-name.txt"],
      ["newer", "/tmp/dl/server-name.txt"],
    ],
  );
  await assert.rejects(call("downloadsInternal.determineFilename", worker(outsider), 5, "evil.txt", ""), {
    message: "Unexpected determineFilename call",
  });
  await call("downloadsInternal.determineFilename", worker(newer), 5, "newer.txt", "overwrite");
  await assert.rejects(call("downloadsInternal.determineFilename", worker(newer), 5, "again.txt", ""), /at most one onDeterminingFilename/);
  await call("downloadsInternal.determineFilename", worker(older), 5, "older.txt", "");
  assert.deepEqual(await decided, { filename: "newer.txt", conflictAction: "overwrite" });
});

test("onDeterminingFilename ignores names that leave the downloads folder", async () => {
  const { service, call, listen } = setup();
  const ext = extension("ext");
  service.loaded.set("ext", ext);
  listen("ext", "downloads.onDeterminingFilename");
  const record = { ...complete(6), state: "in_progress", filename: "" };
  records.set(6, record);
  const decided = manager.determiner(record, "/tmp/dl/x.txt");
  await assert.rejects(call("downloadsInternal.determineFilename", worker(ext), 6, "../../.zshrc", ""), { message: "Invalid filename" });
  assert.equal(await decided, null);
});

test("onDeterminingFilename isn't offered to extensions without the downloads permission", () => {
  const { service, listen } = setup();
  service.loaded.set("noperm", extension("noperm", { permissions: [] }));
  listen("noperm", "downloads.onDeterminingFilename");
  assert.equal(manager.determiner({ id: 1 }, "/tmp/x"), null);
});

test("onChanged sends every field the first time a download changes after nobody listened at creation", () => {
  const current = { id: 3, url: "u", finalUrl: "u", filename: "/f", danger: "safe", mime: "m", startTime: "t", state: "in_progress", canResume: false, paused: false, totalBytes: 9, fileSize: 9, exists: true, bytesReceived: 1 };
  const delta = downloadDelta(3, undefined, current);
  assert.deepEqual(Object.keys(delta).filter((k) => k !== "id").sort(), ["canResume", "danger", "exists", "fileSize", "filename", "finalUrl", "mime", "paused", "startTime", "state", "totalBytes", "url"]);
  assert.deepEqual(delta.state, { current: "in_progress" });
  assert.equal(downloadDelta(3, { json: current, completed: false, removed: false }, { ...current, bytesReceived: 5 }), null);
  assert.deepEqual(downloadDelta(3, { json: current, completed: false, removed: false }, { ...current, state: "complete" }).state, {
    current: "complete",
    previous: "in_progress",
  });
  assert.deepEqual(downloadDelta(3, { json: {}, completed: true, removed: false }, { ...current, exists: false }), {
    id: 3,
    exists: { current: false, previous: true },
  });
});

test("download mime types follow the saved file's extension like Chrome", () => {
  assert.equal(mimeForFile("/x/a.txt"), "text/plain");
  assert.equal(mimeForFile("/x/a.PNG"), "image/png");
  assert.equal(mimeForFile("/x/a.unknownext"), null);
});

test("downloads.open right after a click in the popup opens a safe type without asking, like Chrome", async () => {
  const { call, prompts } = setup();
  complete(1, fileNamed("notes.txt"));
  const ext = extension("ext", { permissions: ["downloads", "downloads.open"] });
  await call("downloads.open", clickedPopup(ext), 1);
  assert.equal(prompts.length, 0);
  assert.deepEqual(opened, [1]);
});

test("downloads.open always asks before opening a type that can run code, even right after a click in the popup", async () => {
  const { call, prompts, answerPrompt } = setup();
  const ext = extension("ext", { permissions: ["downloads", "downloads.open"] });
  const risky = ["payload.sh", "Installer.pkg", "Tool.jar", ...(process.platform === "darwin" ? ["Report.command", "link.fileloc"] : ["app.desktop"])];
  for (const [index, name] of risky.entries()) {
    complete(index + 1, fileNamed(name));
    answerPrompt(false);
    await assert.rejects(call("downloads.open", clickedPopup(ext), index + 1), { message: 'The "downloads.open" permission is required' }, name);
    assert.equal(prompts.length, index + 1, name);
    assert.match(prompts[index].warnings[0], new RegExp(name.replace(".", "\\.")));
  }
  assert.deepEqual(opened, []);
  answerPrompt(true);
  await call("downloads.open", clickedPopup(ext), 1);
  assert.deepEqual(opened, [1]);
});

test("downloads.open asks again for a file whose danger the user overrode", async () => {
  const { call, prompts } = setup();
  records.set(1, { ...complete(1, fileNamed("notes.txt")), danger: "accepted" });
  const ext = extension("ext", { permissions: ["downloads", "downloads.open"] });
  await assert.rejects(call("downloads.open", clickedPopup(ext), 1), { message: 'The "downloads.open" permission is required' });
  assert.equal(prompts.length, 1);
  assert.deepEqual(opened, []);
});

test("a dangerous download can't be opened before the user keeps it", async () => {
  const { call } = setup();
  records.set(1, { ...complete(1, fileNamed("payload.sh")), state: "in_progress", danger: "file" });
  const ext = extension("ext", { permissions: ["downloads", "downloads.open"] });
  await assert.rejects(call("downloads.open", clickedPopup(ext), 1), { message: "Download must be complete" });
  assert.deepEqual(opened, []);
});

test("downloads.acceptDanger asks the user every time; Keep validates and Cancel removes, like Chrome", async () => {
  const { call, prompts, answerPrompt } = setup();
  accepted.length = 0;
  const ext = extension("ext", { permissions: ["downloads"] });
  records.set(1, { ...complete(1, "/tmp/dl/payload.sh"), state: "in_progress", danger: "file" });
  answerPrompt(true);
  await call("downloads.acceptDanger", clickedPopup(ext), 1);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].warnings[0], /payload\.sh/);
  assert.deepEqual(accepted, [1]);
  assert.equal(records.get(1).danger, "accepted");
  records.set(2, { ...complete(2, "/tmp/dl/other.sh"), state: "in_progress", danger: "file" });
  answerPrompt(false);
  await call("downloads.acceptDanger", clickedPopup(ext), 2);
  assert.deepEqual(erased, [2]);
  records.set(3, { ...complete(3), state: "in_progress" });
  await assert.rejects(call("downloads.acceptDanger", clickedPopup(ext), 3), { message: "Download must be dangerous" });
  assert.equal(prompts.length, 2);
});

test("downloads report the danger Chrome would", () => {
  const { service, listen, dispatched } = setup();
  const ext = extension("ext");
  service.loaded.set(ext.id, ext);
  listen("ext", "downloads.onCreated");
  manager.created.emit({ ...complete(4, "/tmp/dl/payload.sh"), state: "in_progress", danger: "file" });
  assert.equal(dispatched.at(-1).args[0].danger, "file");
});
