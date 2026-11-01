const assert = require("node:assert/strict");
const { test } = require("node:test");

const electron = require("./fake-electron.js");
const { Router } = require("../dist/extensions/router.js");
const { channelFor } = require("../dist/extensions/protocol.js");

const OWN = "a".repeat(32);
const OTHER = "b".repeat(32);
const METHOD = "history.search";

function extension(id, permissions = []) {
  return { id, hasApiPermission: (permission) => permissions.includes(permission) };
}

const session = new electron.FakeSession("router");
const loaded = new Map([
  [OWN, extension(OWN, ["history"])],
  [OTHER, extension(OTHER)],
]);
const router = new Router(session, (id) => loaded.get(id) ?? null);
const calls = [];
router.handle(METHOD, (caller, ...args) => {
  calls.push({ caller, args });
  return caller.extension.id;
}, { permission: "history" });
router.listen();

function frameEvent(origin, overrides = {}) {
  const frame = { origin, parent: null };
  return { sender: { session, mainFrame: frame, id: 7 }, senderFrame: frame, ...overrides };
}

function invoke(method, event, ...args) {
  return electron.invokeHandlers.get(channelFor(method))(event, ...args);
}

test("every API method gets its own channel once the router listens", () => {
  assert.ok(electron.invokeHandlers.has(channelFor(METHOD)));
  assert.ok([...electron.invokeHandlers.keys()].every((channel) => channel.startsWith("tb-ext")));
});

test("the caller is the extension that owns the sending frame, whatever the arguments say", async () => {
  assert.equal(await invoke(METHOD, frameEvent(`chrome-extension://${OWN}`), { extensionId: OTHER }, OTHER), OWN);
  assert.equal(calls.at(-1).caller.kind, "frame");
  assert.deepEqual(calls.at(-1).args, [{ extensionId: OTHER }, OTHER]);
});

test("web pages, unknown extensions, other sessions and missing frames are refused", async () => {
  const refused = /history\.search is only available to extensions/;
  await assert.rejects(async () => invoke(METHOD, frameEvent("https://evil.example")), refused);
  await assert.rejects(async () => invoke(METHOD, frameEvent(`chrome-extension://${"c".repeat(32)}`)), refused);
  await assert.rejects(async () => invoke(METHOD, frameEvent("null")), refused);
  const elsewhere = frameEvent(`chrome-extension://${OWN}`);
  elsewhere.sender = { ...elsewhere.sender, session: new electron.FakeSession("other") };
  await assert.rejects(async () => invoke(METHOD, elsewhere), refused);
  await assert.rejects(async () => invoke(METHOD, { sender: { session }, senderFrame: null }), refused);
});

test("the caller extension is only derived from Chromium's exact origin and scope spelling", async () => {
  const refused = /history\.search is only available to extensions/;
  for (const origin of [
    `CHROME-EXTENSION://${OWN}`,
    `chrome-extension://${OWN.toUpperCase()}`,
    `chrome-extension://${OWN}/x`,
    ` chrome-extension://${OWN}`,
    `chrome-extension:${OWN}`,
    `blob:chrome-extension://${OWN}`,
  ]) {
    await assert.rejects(async () => invoke(METHOD, frameEvent(origin)), refused, origin);
  }
  for (const scope of [`CHROME-EXTENSION://${OWN}/`, `chrome-extension:\\\\${OWN}\\`, `https://${OWN}/`]) {
    assert.equal(router.callerForWorker({ scope }), null, scope);
  }
  assert.equal(router.callerForWorker({ scope: `chrome-extension://${OWN}/` }).extension.id, OWN);
});

test("a call without the manifest permission gets Chrome's error", async () => {
  await assert.rejects(
    async () => invoke(METHOD, frameEvent(`chrome-extension://${OTHER}`)),
    { message: "'history' permission is required to use chrome.history.search" },
  );
});

test("service worker callers come from the worker's scope and session", async () => {
  const handlers = new Map();
  const worker = (scope) => ({ scope, ipc: { handle: (channel, handler) => handlers.set(`${scope} ${channel}`, handler) } });
  const own = worker(`chrome-extension://${OWN}/`);
  const web = worker("https://evil.example/");
  router.wireWorker(own);
  router.wireWorker(web);
  const call = (target, event) => handlers.get(`${target.scope} ${channelFor(METHOD)}`)(event, OTHER);

  assert.equal(await call(own, { session, serviceWorker: own }), OWN);
  assert.equal(calls.at(-1).caller.kind, "worker");
  await assert.rejects(async () => call(web, { session, serviceWorker: web }), /only available to extensions/);
  await assert.rejects(
    async () => call(own, { session: new electron.FakeSession("other"), serviceWorker: own }),
    /only available to extensions/,
  );
});

test("methods outside the API spec can't be registered, and listed ones without a handler are unsupported", async () => {
  assert.throws(() => router.handle("debugger.sendRawCommand", () => {}), /missing from the API spec/);
  await assert.rejects(async () => invoke("history.deleteAll", frameEvent(`chrome-extension://${OWN}`)), {
    message: "chrome.history.deleteAll is not supported in terminal-browser",
  });
});
