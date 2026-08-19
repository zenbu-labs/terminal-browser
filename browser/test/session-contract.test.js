const assert = require("node:assert/strict");
const test = require("node:test");

const {
  closeAction,
  ownsSender,
  resolveSessionOptions,
} = require("../dist/session/contract.js");

test("quit URL capability is absent by default and from app mode", () => {
  assert.equal(resolveSessionOptions([]).allowQuitUrl, false);
  const app = resolveSessionOptions(["--app-mode"]);
  assert.equal(app.allowQuitUrl, false);
  assert.equal(app.argv.includes("--allow-quit-url"), false);
});

test("quit URL capability requires its explicit flag", () => {
  assert.equal(resolveSessionOptions(["--allow-quit-url"]).allowQuitUrl, true);
});

test("verified IPC accepts only an owning main frame", () => {
  const mainFrame = {};
  const subframe = {};
  const ownsContents = (id) => id === 11;

  assert.equal(ownsSender(mainFrame, mainFrame, 11, ownsContents), true);
  assert.equal(ownsSender(subframe, mainFrame, 11, ownsContents), false);
  assert.equal(ownsSender(mainFrame, mainFrame, 12, ownsContents), false);
  assert.equal(ownsSender(mainFrame, mainFrame, 99, ownsContents), false);
});

test("existing tab lifecycle shuts down only for the last tab", () => {
  assert.equal(closeAction(1), "shutdown");
  assert.equal(closeAction(2), "close");
});
