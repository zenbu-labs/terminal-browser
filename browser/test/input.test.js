const assert = require("node:assert/strict");
const { test } = require("node:test");

const { PageInput } = require("../dist/page/input.js");

/** A page that remembers what was sent to it instead of drawing anything. */
function fakePage() {
  const sent = [];
  const cdp = [];
  const contents = {
    sendInputEvent: (event) => sent.push(event),
    insertText: (text) => sent.push({ type: "insertText", text }),
  };
  const target = {
    contents: () => contents,
    scale: () => 1,
    focus: () => {},
    cdp: async (method, params) => {
      cdp.push({ method, ...params });
    },
  };
  return { sent, cdp, target };
}

function press(key, mods = {}) {
  return {
    key,
    kind: "press",
    text: key.length === 1 ? key : undefined,
    mods: { shift: false, alt: false, ctrl: false, super: false, ...mods },
  };
}

/** cdp dispatch is awaited inside key(), so let those promises settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("without the remap, cmd chords reach the page as meta", () => {
  const { sent, target } = fakePage();
  new PageInput(target).key(press("p", { super: true }));
  assert.deepEqual(sent[0], {
    type: "rawKeyDown",
    keyCode: "p",
    modifiers: ["meta"],
  });
});

test("the remap turns a cmd chord into the matching ctrl chord", () => {
  const { sent, target } = fakePage();
  new PageInput(target, true).key(press("p", { super: true }));
  assert.deepEqual(sent[0], {
    type: "rawKeyDown",
    keyCode: "p",
    modifiers: ["ctrl"],
  });
});

test("the remap leaves a real ctrl chord alone", () => {
  const { sent, target } = fakePage();
  new PageInput(target, true).key(press("p", { ctrl: true }));
  assert.deepEqual(sent[0].modifiers, ["ctrl"]);
});

test("the remap keeps shift alongside the rewritten modifier", () => {
  const { sent, target } = fakePage();
  new PageInput(target, true).key(press("p", { super: true, shift: true }));
  assert.deepEqual(sent[0].modifiers, ["shift", "ctrl"]);
});

test("copy, cut and paste keep cmd, because chromium only runs those natively", () => {
  for (const key of ["c", "v", "x"]) {
    const { sent, target } = fakePage();
    new PageInput(target, true).key(press(key, { super: true }));
    assert.deepEqual(sent[0].modifiers, ["meta"], `${key} should still be a meta chord`);
  }
});

test("holding cmd is reported as meta even with the remap on", () => {
  const { sent, target } = fakePage();
  new PageInput(target, true).key(press("leftsuper", { super: true }));
  assert.deepEqual(sent[0].modifiers, ["meta", "left"]);
  assert.equal(sent[0].keyCode, "meta");
});

test("cursor motion keeps cmd and its editing command", async () => {
  const { cdp, target } = fakePage();
  new PageInput(target, true).key(press("left", { super: true }));
  await settle();
  assert.equal(cdp[0].method, "Input.dispatchKeyEvent");
  assert.deepEqual(cdp[0].commands, ["moveToLeftEndOfLine"]);
});

test("without the remap, ctrl+a is stolen for the macOS editing command", async () => {
  const { cdp, target } = fakePage();
  new PageInput(target).key(press("a", { ctrl: true }));
  await settle();
  assert.deepEqual(cdp[0].commands, ["moveToLeftEndOfLine"]);
});

test("with the remap, the macOS ctrl editing chords are left to the page", async () => {
  for (const key of ["a", "e", "b", "f", "d", "k", "u", "w"]) {
    const { sent, cdp, target } = fakePage();
    new PageInput(target, true).key(press(key, { ctrl: true }));
    await settle();
    assert.equal(cdp.length, 0, `ctrl+${key} should not become an editing command`);
    assert.deepEqual(sent[0], { type: "rawKeyDown", keyCode: key, modifiers: ["ctrl"] });
  }
});

test("cmd+a becomes ctrl+a rather than a blink selectAll", async () => {
  const { sent, cdp, target } = fakePage();
  new PageInput(target, true).key(press("a", { super: true }));
  await settle();
  assert.equal(cdp.length, 0);
  assert.deepEqual(sent[0].modifiers, ["ctrl"]);
});

test("a remapped chord is released the same way it was pressed", () => {
  const { sent, target } = fakePage();
  const input = new PageInput(target, true);
  input.key(press("p", { super: true }));
  input.key({ ...press("p", { super: true }), kind: "release" });
  assert.deepEqual(sent[1], { type: "keyUp", keyCode: "p", modifiers: ["ctrl"] });
});

test("a remapped chord does not also type its character", () => {
  const { sent, target } = fakePage();
  new PageInput(target, true).key(press("p", { super: true }));
  assert.equal(sent.some((event) => event.type === "char"), false);
});

test("plain typing is untouched by the remap", () => {
  const { sent, target } = fakePage();
  new PageInput(target, true).key(press("p"));
  assert.deepEqual(sent[0], { type: "rawKeyDown", keyCode: "p", modifiers: [] });
  assert.deepEqual(sent[1], { type: "char", keyCode: "p", modifiers: [] });
});
