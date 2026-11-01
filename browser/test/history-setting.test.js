const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-history-data-"));
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-history-config-"));
const electron = require("./fake-electron.js");
const { SETTINGS_FILE, historyEntry, deleteAllHistory } = require("shared");
const { HistoryRecorder } = require("../dist/browsing/history.js");

const recorder = new HistoryRecorder();
const local = new EventEmitter();
local.session = electron.session.defaultSession;
local.getURL = () => "";
const ssh = new EventEmitter();
ssh.session = electron.session.fromPartition("persist:ssh-host");
ssh.getURL = () => "";
recorder.watch(local);
recorder.watch(ssh);

function setRecord(value) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(value === undefined ? {} : { "history.record": value }));
  recorder.readMode();
}

function visit(contents, url) {
  contents.emit("did-navigate", {}, url);
  return historyEntry(url) !== null;
}

test("by default SSH windows are not recorded", () => {
  deleteAllHistory();
  setRecord(undefined);
  assert.equal(visit(local, "https://local.example/1"), true);
  assert.equal(visit(ssh, "https://ssh.example/1"), false);
});

test("all records every window and off records none", () => {
  setRecord("all");
  assert.equal(visit(ssh, "https://ssh.example/2"), true);
  setRecord("off");
  assert.equal(visit(local, "https://local.example/3"), false);
  assert.equal(recorder.add("https://extension.example/", "link"), null);
  setRecord("local");
  assert.equal(visit(local, "https://local.example/4"), true);
  assert.equal(visit(ssh, "https://ssh.example/4"), false);
});

test("internal pages are never recorded", () => {
  setRecord("all");
  assert.equal(visit(local, "terminal-browser://settings"), false);
});
