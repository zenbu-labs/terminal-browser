const assert = require("node:assert/strict");
const Module = require("node:module");
const { test } = require("node:test");

// browser-session.js imports electron, which only exists inside the Electron runtime.
const listeners = new Map();
const allContents = [];
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request !== "electron") return load.call(this, request, ...rest);
  return {
    app: { getPath: () => "/tmp", on: (event, listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener]) },
    webContents: { getAllWebContents: () => allContents },
  };
};

const { routeThroughProxy } = require("../dist/web/browser-session.js");

function contents(session) {
  const page = { session, policy: null, setWebRTCIPHandlingPolicy: (policy) => (page.policy = policy) };
  return page;
}

test("a proxied session's WebRTC goes through the proxy, including the window that asked for it", async () => {
  const proxied = { setProxy: async () => {} };
  const other = { setProxy: async () => {} };
  const first = contents(proxied);
  const unrelated = contents(other);
  allContents.push(first, unrelated);
  await routeThroughProxy(proxied, "http://127.0.0.1:9");
  assert.equal(first.policy, "disable_non_proxied_udp");
  assert.equal(unrelated.policy, null);
  const later = contents(proxied);
  for (const listener of listeners.get("web-contents-created") ?? []) listener({}, later);
  assert.equal(later.policy, "disable_non_proxied_udp");
});
