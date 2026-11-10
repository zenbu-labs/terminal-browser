const assert = require("node:assert/strict");
const Module = require("node:module");
const { test } = require("node:test");

// input.js imports electron for clipboard access, which only exists inside the Electron runtime.
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === "electron" ? {} : load.call(this, request, ...rest);
};

const { PageInput } = require("../dist/web/input.js");

const mods = { shift: false, alt: false, ctrl: false, super: false };

function fakeTarget() {
  const calls = [];
  const contents = {
    sendInputEvent: (event) => calls.push(["sendInputEvent", event]),
    insertText: (text) => calls.push(["insertText", text]),
  };
  return {
    calls,
    target: {
      contents: () => contents,
      scale: () => 1,
      focus: () => {},
      cdp: async (method, params) => calls.push(["cdp", method, params]),
    },
  };
}

test("text without a key code is inserted into the focused frame through CDP", async () => {
  const { calls, target } = fakeTarget();
  new PageInput(target).key({ key: "unknown", kind: "press", text: "å", mods });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [["cdp", "Input.insertText", { text: "å" }]]);
});
