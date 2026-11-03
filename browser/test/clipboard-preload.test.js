const assert = require("node:assert/strict");
const Module = require("node:module");
const vm = require("node:vm");
const { test } = require("node:test");

const grabFile = require.resolve("../dist/grab/grab.js");
const clipboardFile = require.resolve("../dist/session/clipboard.js");
const written = [];
const load = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === "electron") return { app: { getPath: () => "/tmp/terminal-browser-preload-test" } };
  if (parent?.filename === grabFile && request === "node:fs") {
    return {
      readFileSync: () => "window.reactGrabLoaded = true;",
      writeFileSync: (file, source) => written.push([file, source]),
    };
  }
  if (parent?.filename === grabFile && request === "../assets") {
    return { bundledAsset: () => "/tmp/react-grab-test.js" };
  }
  return load.call(this, request, parent, ...rest);
};
let reactGrabPreloadPath;
try {
  ({ reactGrabPreloadPath } = require(grabFile));
} finally {
  Module._load = load;
}

function run(source, mainFrame) {
  const calls = [];
  vm.runInNewContext(source, {
    process: { isMainFrame: mainFrame },
    require: (request) => {
      assert.equal(request, "electron");
      return { webFrame: {
        executeJavaScript: (code) => {
          new vm.Script(code);
          calls.push(["main", code]);
        },
        setIsolatedWorldInfo: (id, info) => calls.push(["world", id, info.name]),
        executeJavaScriptInIsolatedWorld: (id, scripts) => {
          scripts.forEach(({ code }) => new vm.Script(code));
          calls.push(["isolated", id, scripts[0].code]);
        },
      } };
    },
  });
  return calls;
}

test("the real grab preload installs both clipboard routes without copy-on-selection", () => {
  const file = reactGrabPreloadPath();
  assert.equal(file, "/tmp/terminal-browser-preload-test/terminal-browser-react-grab-preload.js");
  assert.equal(written.length, 1);
  const calls = run(written[0][1], true);
  assert.deepEqual(calls.map(([kind]) => kind), ["main", "main", "world", "isolated"]);
  assert.match(calls[0][1], /__REACT_GRAB_DISABLED__ = true/);
  assert.match(calls[0][1], /reactGrabLoaded/);
  assert.match(calls[1][1], /writeText/);
  assert.match(calls[3][2], /\["copy", "cut"\]/);
  assert.doesNotMatch(calls[3][2], /mouseup/);
  assert.equal(require.cache[clipboardFile] !== undefined, true);
});

test("the preload does not install clipboard bindings or hooks in subframes", () => {
  reactGrabPreloadPath();
  assert.deepEqual(run(written[0][1], false), []);
});

test("repeated requests reuse the generated preload file", () => {
  const first = reactGrabPreloadPath();
  assert.equal(reactGrabPreloadPath(), first);
  assert.equal(written.length, 1);
});
