const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

// browser-session.js imports electron, which only exists inside the Electron runtime.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-permissions-"));
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === "electron" ? { app: { getPath: () => userData } } : load.call(this, request, ...rest);
};

const { configureBrowserSession, onPermissionFor } = require("../dist/web/browser-session.js");

function fakeSession() {
  const handlers = {};
  configureBrowserSession({
    registerPreloadScript: () => {},
    setPermissionRequestHandler: (handler) => (handlers.request = handler),
    setPermissionCheckHandler: (handler) => (handlers.check = handler),
    webRequest: { onBeforeRequest: () => {} },
    protocol: { handle: () => {} },
    on: () => {},
  });
  return handlers;
}

function fakeContents(url = "https://example.com/page") {
  const listeners = new Map();
  return {
    id: Math.random(),
    url,
    getURL() {
      return this.url;
    },
    on: (event, listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
    once: (event, listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
    off: (event, listener) =>
      listeners.set(event, (listeners.get(event) ?? []).filter((candidate) => candidate !== listener)),
    emit: (event, ...args) => {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
    listenerCount: (event) => (listeners.get(event) ?? []).length,
  };
}

function gatedContents(asked, gate = {}) {
  const contents = fakeContents();
  onPermissionFor(contents, {
    request: async (request) => {
      asked.push(request.permission);
      return gate.request ? gate.request(request) : false;
    },
    check: (check) => {
      asked.push(`check ${check.permission}`);
      return false;
    },
  });
  return contents;
}

function request(handlers, contents, permission, details = {}) {
  return new Promise((resolve) =>
    handlers.request(contents, permission, resolve, {
      requestingUrl: "https://www.google.com/recaptcha/api2/anchor",
      isMainFrame: false,
      ...details,
    }),
  );
}

test("storage access from an embedded frame is granted without asking", async () => {
  const handlers = fakeSession();
  const asked = [];
  const contents = gatedContents(asked);
  assert.equal(await request(handlers, contents, "storage-access"), true);
  assert.equal(await request(handlers, contents, "top-level-storage-access"), true);
  const details = { requestingUrl: "https://www.google.com/recaptcha/api2/anchor" };
  assert.equal(handlers.check(contents, "storage-access", "https://www.google.com", details), true);
  assert.deepEqual(asked, []);
});

test("geolocation still goes to the permission prompt", async () => {
  const handlers = fakeSession();
  const asked = [];
  const contents = gatedContents(asked);
  assert.equal(await request(handlers, contents, "geolocation"), false);
  assert.deepEqual(asked, ["geolocation"]);
});

test("a request carries the page it was made on as the embedder", async () => {
  const handlers = fakeSession();
  const seen = [];
  const contents = gatedContents([], { request: (request) => (seen.push(request), true) });
  assert.equal(await request(handlers, contents, "notifications"), true);
  assert.equal(seen[0].origin, "https://www.google.com");
  assert.equal(seen[0].embedder, "https://example.com");
});

test("a request from a document the tab has navigated away from is denied without asking", async () => {
  const handlers = fakeSession();
  const asked = [];
  const contents = gatedContents(asked, { request: () => true });
  const allowed = await request(handlers, contents, "notifications", {
    requestingUrl: "https://old.example.org/",
    isMainFrame: true,
  });
  assert.equal(allowed, false);
  assert.deepEqual(asked, []);
});

test("navigating the page cancels its pending request", async () => {
  const handlers = fakeSession();
  let signal = null;
  const contents = gatedContents([], {
    request: (request) => {
      signal = request.signal;
      return new Promise(() => {});
    },
  });
  const pending = request(handlers, contents, "notifications");
  contents.emit("did-navigate");
  assert.equal(await pending, false);
  assert.equal(signal.aborted, true);
  assert.equal(contents.listenerCount("did-navigate"), 0);
});
