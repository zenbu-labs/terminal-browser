const assert = require("node:assert/strict");
const Module = require("node:module");
const { test } = require("node:test");

const fakeService = {
  addWindow: () => ({ id: 1 }),
  removeWindow() {},
  sidePanels: { view: () => ({ panels: [], showing: null }) },
  actions: { toolbar: () => [] },
};
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return {};
  if (request.endsWith("/extensions/service")) return { extensionService: () => fakeService };
  return load.call(this, request, ...rest);
};

const { PaneExtensions } = require("../dist/session/extensions.js");

function pane() {
  const hooks = new Proxy({ windowToken: "w" }, { get: (target, key) => (key in target ? target[key] : () => {}) });
  return new PaneExtensions(hooks);
}

function ask(extensions) {
  let answer = null;
  extensions.prompt({ kind: "install", extensionId: "x", name: "x", icon: null, warnings: [] }).then((accepted) => (answer = accepted));
  return () => answer;
}

const key = (name, kind = "press") => ({ key: name, kind, mods: {} });
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("Enter right after a prompt opens doesn't accept it", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const extensions = pane();
  const answer = ask(extensions);
  now += 100;
  assert.equal(extensions.handleKey(key("enter")), true);
  await settle();
  assert.equal(answer(), null);
  assert.equal(extensions.prompts.length, 1);
  now += 600;
  extensions.handleKey(key("enter"));
  await settle();
  assert.equal(answer(), true);
});

test("a held key or a quick run of typing can't accept the prompt", async (t) => {
  let now = 2_000_000;
  t.mock.method(Date, "now", () => now);
  const extensions = pane();
  const answer = ask(extensions);
  for (let i = 0; i < 40; i++) {
    now += 100;
    extensions.handleKey(key("a"));
  }
  now += 100;
  extensions.handleKey(key("enter"));
  for (let i = 0; i < 20; i++) {
    now += 30;
    extensions.handleKey(key("enter", "repeat"));
  }
  await settle();
  assert.equal(answer(), null);
  now += 600;
  extensions.handleKey(key("enter"));
  await settle();
  assert.equal(answer(), true);
});

test("a click on the accept button needs the same delay, Escape and Cancel always work", async (t) => {
  let now = 3_000_000;
  t.mock.method(Date, "now", () => now);
  const extensions = pane();
  const first = ask(extensions);
  now += 50;
  extensions.answerPrompt(true);
  await settle();
  assert.equal(first(), null);
  extensions.handleKey(key("escape"));
  await settle();
  assert.equal(first(), false);
  const second = ask(extensions);
  extensions.answerPrompt(false);
  await settle();
  assert.equal(second(), false);
});

test("the next queued prompt waits again before Enter can accept it", async (t) => {
  let now = 4_000_000;
  t.mock.method(Date, "now", () => now);
  const extensions = pane();
  const first = ask(extensions);
  const second = ask(extensions);
  now += 700;
  extensions.handleKey(key("enter"));
  now += 700;
  extensions.answerPrompt(true);
  await settle();
  assert.equal(first(), true);
  assert.equal(second(), true);
  const third = ask(extensions);
  const fourth = ask(extensions);
  now += 700;
  extensions.handleKey(key("enter"));
  now += 100;
  extensions.handleKey(key("enter"));
  await settle();
  assert.equal(third(), true);
  assert.equal(fourth(), null);
});
