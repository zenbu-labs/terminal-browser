const assert = require("node:assert/strict");
const Module = require("node:module");
const { test } = require("node:test");

function loadCreateRootWithFakeEngine(calls) {
  class FakeEngine {
    info() {
      return JSON.stringify({
        width: 400,
        height: 200,
        cellWidth: 10,
        cellHeight: 20,
        basePx: 16,
        kittyKeyboard: true,
        hosted: false,
        colors: { foreground: null, background: null, palette: [] },
      });
    }
    setKeyEventTypes() {}
    setFocusClick(enabled) {
      calls.push(`setFocusClick:${enabled}`);
    }
    start() {
      calls.push("start");
    }
    applyOps() {}
    stop() {}
  }

  const load = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "electron") return {};
    if (request.endsWith("/pixel.node")) return { PixelEngine: FakeEngine, highlightCaptures: () => [] };
    return load.call(this, request, ...rest);
  };
  try {
    return require("../dist/react/index.js").createRoot;
  } finally {
    Module._load = load;
  }
}

test("an explicit focus click off reaches the engine before it starts", () => {
  const calls = [];
  const createRoot = loadCreateRootWithFakeEngine(calls);
  const root = createRoot({ focusClick: false, devtools: false });
  try {
    assert.deepEqual(calls, ["setFocusClick:false", "start"]);
  } finally {
    root.stop();
  }
});
