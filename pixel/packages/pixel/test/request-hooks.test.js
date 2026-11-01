const assert = require("node:assert/strict");
const { test } = require("node:test");

const { requestHooks, urlPatternMatches } = require("../dist/web/request-hooks.js");

function fakeSession() {
  const listeners = {};
  const register = (event) => (filter, listener) => {
    if (typeof filter === "function" || filter === null) [filter, listener] = [null, filter];
    listeners[event] = listener ? { filter, listener } : null;
  };
  return {
    listeners,
    webRequest: {
      onBeforeRequest: register("beforeRequest"),
      onBeforeSendHeaders: register("sendHeaders"),
      onHeadersReceived: register("headersReceived"),
      onBeforeRedirect: register("beforeRedirect"),
    },
    request(details) {
      let result;
      listeners.beforeRequest?.listener(details, (response) => (result = response));
      return result;
    },
  };
}

test("one listener serves every hook, filtered to the union of their urls", () => {
  const session = fakeSession();
  const hooks = requestHooks(session);
  assert.equal(session.listeners.beforeRequest, undefined);
  const seen = [];
  const removeFile = hooks.beforeRequest({ urls: ["file://*", "file://*/*"] }, (d) => (seen.push(["file", d.url]), { cancel: d.resourceType === "xhr" }));
  const removeDoc = hooks.beforeRequest({ urls: ["doc://*/*"] }, (d) => (seen.push(["doc", d.url]), undefined));
  assert.deepEqual(session.listeners.beforeRequest.filter.urls, ["doc://*/*", "file://*", "file://*/*"]);
  assert.deepEqual(session.request({ url: "file:///etc/hosts", resourceType: "xhr" }), { cancel: true });
  assert.deepEqual(session.request({ url: "doc://file/x", resourceType: "xhr" }), {});
  assert.deepEqual(seen, [["file", "file:///etc/hosts"], ["doc", "doc://file/x"]]);

  removeDoc();
  removeDoc();
  assert.deepEqual(session.listeners.beforeRequest.filter.urls, ["file://*", "file://*/*"]);
  assert.deepEqual(session.request({ url: "file:///etc/hosts", resourceType: "xhr" }), { cancel: true });
  removeFile();
  assert.equal(session.listeners.beforeRequest, null);
});

test("a cancel from any hook wins over another hook's redirect, and a throwing hook cancels", () => {
  const session = fakeSession();
  const hooks = requestHooks(session);
  const removeRedirect = hooks.beforeRequest({ urls: ["https://*/*"] }, () => ({ redirectURL: "https://elsewhere.example/" }));
  assert.deepEqual(session.request({ url: "https://a.example/" }), { redirectURL: "https://elsewhere.example/" });
  const removeCancel = hooks.beforeRequest({ urls: ["https://a.example/*"] }, () => ({ cancel: true }));
  assert.deepEqual(session.request({ url: "https://a.example/" }), { cancel: true });
  assert.deepEqual(session.request({ url: "https://b.example/" }), { redirectURL: "https://elsewhere.example/" });
  removeCancel();
  removeRedirect();
  hooks.beforeRequest({ urls: ["<all_urls>"] }, () => {
    throw new Error("broken hook");
  });
  const error = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(session.request({ url: "https://a.example/" }), { cancel: true });
  } finally {
    console.error = error;
  }
});

test("the same function registered twice is removed one registration at a time", () => {
  const session = fakeSession();
  const hooks = requestHooks(session);
  const guard = () => ({ cancel: true });
  const first = hooks.beforeRequest({ urls: ["file://*/*"] }, guard);
  hooks.beforeRequest({ urls: ["file://*/*"] }, guard);
  first();
  assert.deepEqual(session.request({ url: "file:///x" }), { cancel: true });
});

test("header hooks share one listener each and edit a copy of the headers", () => {
  const session = fakeSession();
  const hooks = requestHooks(session);
  const remove = hooks.beforeSendHeaders((_d, headers) => {
    headers.DNT = "1";
  });
  const requestHeaders = { Accept: "*/*" };
  let response;
  session.listeners.sendHeaders.listener({ requestHeaders }, (r) => (response = r));
  assert.deepEqual(response, { requestHeaders: { Accept: "*/*", DNT: "1" } });
  assert.deepEqual(requestHeaders, { Accept: "*/*" });
  remove();
  assert.equal(session.listeners.sendHeaders, null);
});

test("url patterns match like Electron's request filters", () => {
  assert.equal(urlPatternMatches("file://*", "file:///etc/hosts"), true);
  assert.equal(urlPatternMatches("file://*/*", "file:///etc/hosts"), true);
  assert.equal(urlPatternMatches("terminal-browser-file://*/*", "terminal-browser-file://file/Users/x.js"), true);
  assert.equal(urlPatternMatches("terminal-browser-file://*/*", "file:///Users/x.js"), false);
  assert.equal(urlPatternMatches("*://*.example.com/*", "https://a.example.com/x"), true);
  assert.equal(urlPatternMatches("*://*.example.com/*", "https://example.com/"), true);
  assert.equal(urlPatternMatches("*://*.example.com/*", "https://evil.com/?.example.com/"), false);
  assert.equal(urlPatternMatches("*://*/*", "ftp://a/"), false);
  assert.equal(urlPatternMatches("https://a.example/p*", "https://user@a.example:8443/path?q"), true);
});

test("redirect hooks share one listener, and each sees every redirect", () => {
  const session = fakeSession();
  const hooks = requestHooks(session);
  const seen = [];
  const removeA = hooks.beforeRedirect((d) => seen.push(["a", d.redirectURL]));
  const removeB = hooks.beforeRedirect(() => {
    throw new Error("broken hook");
  });
  const removeC = hooks.beforeRedirect((d) => seen.push(["c", d.redirectURL]));
  const errors = console.error;
  console.error = () => {};
  session.listeners.beforeRedirect.listener({ url: "https://a.example/", redirectURL: "https://b.example/" });
  console.error = errors;
  assert.deepEqual(seen, [["a", "https://b.example/"], ["c", "https://b.example/"]]);
  removeA();
  removeB();
  assert.notEqual(session.listeners.beforeRedirect, null);
  removeC();
  assert.equal(session.listeners.beforeRedirect, null);
});
