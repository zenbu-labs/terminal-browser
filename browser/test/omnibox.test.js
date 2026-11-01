const assert = require("node:assert/strict");
const Module = require("node:module");
const { test } = require("node:test");

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return { app: { getPath: () => "/tmp" }, nativeImage: {} };
  if (request === "shared") {
    return new Proxy(
      { listStep: (event) => (event.key === "down" ? 1 : event.key === "up" ? -1 : 0) },
      { get: (target, name) => target[name] ?? (() => null) },
    );
  }
  return load.call(this, request, ...rest);
};

const { parseDescription } = require("../dist/extensions/omnibox-xml.js");
const { OmniboxStore } = require("../dist/extensions/api/omnibox.js");
const { AddressKeyword } = require("../dist/session/address-keyword.js");

test("descriptions keep Chrome's match, dim and url styles", () => {
  assert.deepEqual(parseDescription("God: <match>hi</match> <dim>&amp; more</dim>"), [
    { text: "God: ", styles: [] },
    { text: "hi", styles: ["match"] },
    { text: " ", styles: [] },
    { text: "& more", styles: ["dim"] },
  ]);
  assert.deepEqual(parseDescription("<url><match>a</match>.com</url>"), [
    { text: "a", styles: ["url", "match"] },
    { text: ".com", styles: ["url"] },
  ]);
});

test("broken descriptions fail with Chrome's XML error", () => {
  assert.throws(
    () => parseDescription("<match>unclosed"),
    {
      message:
        "Invalid XML: bad content: Entity: line 1: parser error : Opening and ending tag mismatch: match line 1 and fragment\n<fragment><match>unclosed</fragment>",
    },
  );
  assert.throws(() => parseDescription("a & b"), /EntityRef: expecting ';'/);
});

function fakeService() {
  const sent = [];
  const extension = { id: "godgodgodgodgodgodgodgodgodgodgo", name: "God", path: "/x", manifest: { omnibox: { keyword: "god" } } };
  const service = {
    loaded: new Map([[extension.id, extension]]),
    onUnload: () => () => {},
    dispatch: (id, event, args) => sent.push([event, ...args]),
  };
  return { service, extension, sent, store: new OmniboxStore(service) };
}

test("keyword mode sends the omnibox events in Chrome's order", () => {
  const { store, extension, sent } = fakeService();
  let changes = 0;
  const keyword = new AddressKeyword(() => store, () => changes++);
  assert.equal(keyword.type("go"), "go");
  assert.equal(keyword.active, false);
  assert.equal(keyword.type("god "), "");
  assert.equal(keyword.active, true);
  assert.equal(keyword.view().name, "God");
  keyword.type("hello");
  const requestId = sent.at(-1)[2];
  store.send(extension, requestId, [{ content: "god-hello", description: "God <match>hello</match>", deletable: true }]);
  assert.equal(keyword.view().rows.length, 2);
  assert.equal(changes > 0, true);
  keyword.key({ key: "down" }, "currentTab");
  keyword.key({ key: "enter" }, "currentTab");
  assert.deepEqual(sent, [
    ["omnibox.onInputStarted"],
    ["omnibox.onInputChanged", "hello", requestId],
    ["omnibox.onInputEntered", "god-hello", "currentTab"],
  ]);
});

test("stale suggestions are ignored and backspace on an empty field leaves keyword mode", () => {
  const { store, extension, sent } = fakeService();
  const keyword = new AddressKeyword(() => store, () => {});
  keyword.type("god a");
  const first = sent.at(-1)[2];
  keyword.type("ab");
  store.send(extension, first, [{ content: "old", description: "old" }]);
  assert.equal(keyword.view().rows.length, 1);
  keyword.type("");
  assert.deepEqual(keyword.captureKeys().includes("backspace"), true);
  assert.deepEqual(keyword.key({ key: "backspace" }, "currentTab"), { text: "god", done: false });
  assert.equal(keyword.active, false);
  assert.deepEqual(sent.at(-1), ["omnibox.onInputCancelled"]);
  assert.deepEqual(keyword.captureKeys(), ["tab"]);
});

test("the default suggestion fills in the typed text", () => {
  const { store, extension } = fakeService();
  store.setDefault(extension, { description: "Search <match>%s</match>" });
  assert.throws(() => store.setDefault(extension, { description: "<dim>x" }), /Invalid XML/);
  const keyword = new AddressKeyword(() => store, () => {});
  keyword.type("god <b>");
  assert.deepEqual(keyword.view().rows[0].runs, [
    { text: "Search ", styles: [] },
    { text: "<b>", styles: ["match"] },
  ]);
});
