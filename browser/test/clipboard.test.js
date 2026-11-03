const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const vm = require("node:vm");
const { test } = require("node:test");

let nativeRead = () => "";
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return { clipboard: { readText: () => nativeRead() } };
  return load.call(this, request, ...rest);
};
const { PageClipboard, clipboardPreload } = require("../dist/session/clipboard.js");
Module._load = load;

const EVENTS = "__terminalBrowserClipboard";
const API = "__terminalBrowserClipboardApiWrite";
const WORLD = "terminal-browser-clipboard";
const WORLD_ID = 1013;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

function preload(copyOnSelect = false, clipboard = {}) {
  const messages = [];
  const listeners = new Map();
  const timers = [];
  const worlds = [];
  let selection = "";
  const main = vm.createContext({ navigator: { clipboard } });
  main.window = main;
  main[API] = (text) => messages.push(["api", text]);
  const isolated = vm.createContext({
    document: { addEventListener: (type, listener) => listeners.set(type, listener) },
    setTimeout: (callback) => timers.push(callback),
    getSelection: () => selection,
  });
  isolated.window = isolated;
  isolated[EVENTS] = (text) => messages.push(["event", text]);
  vm.runInNewContext(clipboardPreload(copyOnSelect), {
    webFrame: {
      executeJavaScript: (code) => vm.runInContext(code, main),
      setIsolatedWorldInfo: (id, info) => worlds.push([id, info.name]),
      executeJavaScriptInIsolatedWorld: (id, scripts) => {
        assert.equal(id, WORLD_ID);
        scripts.forEach(({ code }) => vm.runInContext(code, isolated));
      },
    },
  });
  return {
    main, isolated, listeners, messages, worlds,
    select: (text) => { selection = text; },
    dispatch: (type, event) => listeners.get(type)?.(event),
    flush: () => { while (timers.length) timers.shift()(); },
  };
}

for (const type of ["copy", "cut"]) {
  test(`${type} reads app-owned plain text during trusted event dispatch`, () => {
    const page = preload();
    let text = "  editor text\n";
    page.dispatch(type, {
      isTrusted: true,
      clipboardData: { getData: (format) => {
        assert.equal(format, "text/plain");
        return text;
      } },
    });
    text = "";
    assert.deepEqual(page.messages, [["event", "  editor text\n"]]);
    assert.deepEqual(page.worlds, [[WORLD_ID, WORLD]]);
    assert.equal(page.listeners.has("mouseup"), false);
  });

  test(`${type} ignores synthetic events, empty text, and missing clipboard data`, () => {
    const page = preload();
    page.dispatch(type, { isTrusted: false, clipboardData: { getData: () => "fake" } });
    page.dispatch(type, { isTrusted: true, clipboardData: { getData: () => "" } });
    page.dispatch(type, { isTrusted: true });
    assert.deepEqual(page.messages, []);
  });
}

test("selecting text does not copy unless explicitly enabled", () => {
  const page = preload();
  page.select("selected");
  page.dispatch("mouseup", { isTrusted: true });
  page.flush();
  assert.deepEqual(page.messages, []);
});

test("opt-in copy on selection retains trusted, trimmed, nonduplicate behavior", () => {
  const page = preload(true);
  page.select("  selected  ");
  page.dispatch("mouseup", { isTrusted: false });
  page.flush();
  assert.deepEqual(page.messages, []);
  page.dispatch("mouseup", { isTrusted: true });
  page.flush();
  page.dispatch("mouseup", { isTrusted: true });
  page.flush();
  page.select(" ");
  page.dispatch("mouseup", { isTrusted: true });
  page.flush();
  assert.deepEqual(page.messages, [["event", "selected"]]);
  assert.equal(page.listeners.has("copy"), true);
  assert.equal(page.listeners.has("cut"), true);
});

test("writeText preserves receiver, arguments, result, and waits for native success", async () => {
  const pending = deferred();
  const calls = [];
  const clipboard = { writeText: function (...args) {
    calls.push([this, args]);
    return pending.promise;
  } };
  const page = preload(false, clipboard);
  const result = clipboard.writeText("/project/file.ts", "extra");
  assert.deepEqual(page.messages, []);
  assert.deepEqual(calls, [[clipboard, ["/project/file.ts", "extra"]]]);
  pending.resolve("native result");
  assert.equal(await result, "native result");
  assert.deepEqual(page.messages, [["api", "/project/file.ts"]]);
});

test("rejected writes retain their original rejection and never signal a copy", async () => {
  const failure = new Error("NotAllowedError");
  const clipboard = { writeText: async () => { throw failure; } };
  const page = preload(false, clipboard);
  await assert.rejects(clipboard.writeText("denied"), (error) => error === failure);
  assert.deepEqual(page.messages, []);
});

test("synchronous native errors remain write rejections without a copy", async () => {
  const failure = new TypeError("invalid receiver");
  const clipboard = { writeText: () => { throw failure; } };
  const page = preload(false, clipboard);
  await assert.rejects(clipboard.writeText("text"), (error) => error === failure);
  assert.deepEqual(page.messages, []);
});

test("write forwards a text/plain ClipboardItem after native success", async () => {
  const clipboard = { write: async () => "ok" };
  const page = preload(false, clipboard);
  const item = { types: ["text/html", "text/plain"], getType: async (type) => {
    assert.equal(type, "text/plain");
    return new Blob(["relative/file.ts"]);
  } };
  assert.equal(await clipboard.write([item]), "ok");
  assert.deepEqual(page.messages, [["api", "relative/file.ts"]]);
});

test("image-only and empty writes never become text copies", async () => {
  const clipboard = { write: async () => {}, writeText: async () => {} };
  const page = preload(false, clipboard);
  await clipboard.write([{ types: ["image/png"] }]);
  await clipboard.writeText("");
  assert.deepEqual(page.messages, []);
});

test("failed text extraction or notification does not reject a successful write", async () => {
  const clipboard = { write: async () => "ok", writeText: async () => "ok" };
  const page = preload(false, clipboard);
  assert.equal(await clipboard.write([{ types: ["text/plain"], getType: async () => {
    throw new Error("unavailable");
  } }]), "ok");
  page.main[API] = () => { throw new Error("binding unavailable"); };
  assert.equal(await clipboard.writeText("copied"), "ok");
  assert.deepEqual(page.messages, []);
});

test("insecure contexts without the Clipboard API still install copy/cut listeners", () => {
  const page = preload(false, null);
  assert.equal(page.listeners.has("copy"), true);
  assert.equal(page.listeners.has("cut"), true);
});

function watcher({ native = "", permission = "prompt", renderer = "", read, cdp } = {}) {
  const messages = new EventEmitter();
  const commands = [];
  const copied = [];
  const executions = [];
  const reads = [];
  const state = { active: true, native, permission, renderer };
  nativeRead = () => {
    if (state.native instanceof Error) throw state.native;
    return state.native;
  };
  const view = {
    cdp: async (method, params) => {
      commands.push([method, params]);
      return cdp?.(method, params);
    },
    webContents: {
      debugger: messages,
      executeJavaScriptInIsolatedWorld: async (id, scripts) => {
        executions.push(id);
        return vm.runInNewContext(scripts[0].code, {
          navigator: {
            permissions: { query: async (descriptor) => {
              assert.equal(descriptor.name, "clipboard-read");
              return { state: state.permission };
            } },
            clipboard: { readText: () => {
              reads.push(true);
              return read ? read() : Promise.resolve(state.renderer);
            } },
          },
        });
      },
    },
  };
  const bridge = new PageClipboard(view, {
    active: () => state.active,
    copied: (text) => copied.push(text),
  });
  return {
    bridge, state, copied, commands, messages, executions, reads,
    signal: (name, payload) => messages.emit("message", {}, "Runtime.bindingCalled", { name, payload }),
  };
}

test("bindings register once, with trusted event handling confined to an isolated world", async () => {
  const page = watcher();
  await page.bridge.enable();
  await page.bridge.enable();
  assert.deepEqual(page.commands, [
    ["Runtime.addBinding", { name: EVENTS, executionContextName: WORLD }],
    ["Runtime.addBinding", { name: API }],
  ]);
  assert.equal(page.messages.listenerCount("message"), 1);
  page.signal(EVENTS, "editor copy");
  assert.deepEqual(page.copied, ["editor copy"]);
  page.bridge.dispose();
  page.signal(EVENTS, "after disposal");
  assert.equal(page.messages.listenerCount("message"), 0);
  assert.deepEqual(page.copied, ["editor copy"]);
});

test("native read-back confirms API writes without renderer clipboard access", async () => {
  const page = watcher({ native: "/project/file.ts" });
  await page.bridge.enable();
  page.signal(API, "/project/file.ts");
  await tick();
  assert.deepEqual(page.copied, ["/project/file.ts"]);
  assert.deepEqual(page.executions, []);
});

test("asynchronous native read-back confirms API text without renderer permission", async () => {
  const page = watcher({ native: Promise.resolve("native text") });
  await page.bridge.enable();
  page.signal(API, "native text");
  await tick();
  assert.deepEqual(page.copied, ["native text"]);
  assert.deepEqual(page.executions, []);
});

test("pending native read-back does not fall through to a renderer read", async () => {
  const pending = deferred();
  const page = watcher({ native: pending.promise, permission: "granted", renderer: "text" });
  await page.bridge.enable();
  page.signal(API, "text");
  await tick();
  assert.deepEqual(page.copied, []);
  assert.deepEqual(page.executions, []);
  pending.resolve("text");
  await tick();
  assert.deepEqual(page.copied, ["text"]);
  assert.deepEqual(page.executions, []);
});

for (const permission of ["granted", "denied"]) {
  test(`a rejected native read respects ${permission} renderer permission`, async () => {
    const pending = deferred();
    const page = watcher({ native: pending.promise, permission, renderer: "text" });
    await page.bridge.enable();
    page.signal(API, "text");
    pending.reject(new Error("native clipboard unavailable"));
    await tick();
    assert.deepEqual(page.copied, permission === "granted" ? ["text"] : []);
    assert.equal(page.reads.length, permission === "granted" ? 1 : 0);
  });
}

for (const invalidate of ["dispose", "navigate", "contexts cleared", "inactive", "newer copy", "newer API"]) {
  test(`pending native read-back cannot publish after ${invalidate}`, async () => {
    const pending = deferred();
    const page = watcher({ native: pending.promise });
    await page.bridge.enable();
    page.signal(API, "old");
    await tick();
    assert.deepEqual(page.copied, []);
    assert.deepEqual(page.executions, []);
    if (invalidate === "dispose") page.bridge.dispose();
    if (invalidate === "navigate") page.messages.emit("message", {}, "Page.frameNavigated", { frame: {} });
    if (invalidate === "contexts cleared") page.messages.emit("message", {}, "Runtime.executionContextsCleared", {});
    if (invalidate === "inactive") page.state.active = false;
    if (invalidate === "newer copy") page.signal(EVENTS, "new");
    if (invalidate === "newer API") {
      page.state.native = Promise.resolve("new");
      page.signal(API, "new");
      await tick();
    }
    pending.resolve("old");
    await tick();
    assert.deepEqual(page.copied, invalidate.startsWith("newer") ? ["new"] : []);
  });
}

for (const permission of ["prompt", "denied"]) {
  test(`API signals cannot copy arbitrary payloads with ${permission} read permission`, async () => {
    const page = watcher({ native: "other", permission, renderer: "forged" });
    await page.bridge.enable();
    page.signal(API, "forged");
    await tick();
    assert.deepEqual(page.copied, []);
    assert.deepEqual(page.reads, []);
    assert.deepEqual(page.executions, [WORLD_ID]);
  });
}

test("an already-granted isolated renderer read can confirm a native mismatch", async () => {
  const page = watcher({ native: new Error("unavailable"), permission: "granted", renderer: "path" });
  await page.bridge.enable();
  page.signal(API, "path");
  await tick();
  assert.deepEqual(page.copied, ["path"]);
  assert.equal(page.reads.length, 1);
});

test("renderer mismatches and failed reads never forward a page-provided payload", async () => {
  for (const read of [async () => "different", async () => { throw new Error("denied"); }]) {
    const page = watcher({ permission: "granted", read });
    await page.bridge.enable();
    page.signal(API, "forged");
    await tick();
    assert.deepEqual(page.copied, []);
  }
});

test("unrelated bindings, malformed payloads, and inactive pages are ignored", async () => {
  const page = watcher({ native: "text" });
  await page.bridge.enable();
  page.signal("unrelated", "text");
  page.signal(EVENTS, {});
  page.signal(API, null);
  page.signal(EVENTS, "");
  page.state.active = false;
  page.signal(EVENTS, "text");
  page.signal(API, "text");
  await tick();
  assert.deepEqual(page.copied, []);
  assert.deepEqual(page.executions, []);
});

for (const invalidate of ["dispose", "navigate", "contexts cleared", "inactive", "newer copy"]) {
  test(`a pending renderer read cannot copy after ${invalidate}`, async () => {
    const pending = deferred();
    const page = watcher({ permission: "granted", read: () => pending.promise });
    await page.bridge.enable();
    page.signal(API, "old");
    await tick();
    if (invalidate === "dispose") page.bridge.dispose();
    if (invalidate === "navigate") page.messages.emit("message", {}, "Page.frameNavigated", { frame: {} });
    if (invalidate === "contexts cleared") page.messages.emit("message", {}, "Runtime.executionContextsCleared", {});
    if (invalidate === "inactive") page.state.active = false;
    if (invalidate === "newer copy") page.signal(EVENTS, "new");
    pending.resolve("old");
    await tick();
    assert.deepEqual(page.copied, invalidate === "newer copy" ? ["new"] : []);
  });
}

test("subframe navigation does not cancel a main-frame read", async () => {
  const pending = deferred();
  const page = watcher({ permission: "granted", read: () => pending.promise });
  await page.bridge.enable();
  page.signal(API, "text");
  await tick();
  page.messages.emit("message", {}, "Page.frameNavigated", { frame: { parentId: "main" } });
  pending.resolve("text");
  await tick();
  assert.deepEqual(page.copied, ["text"]);
});

test("a failed binding registration removes its listener and permits a retry", async () => {
  let fail = true;
  const page = watcher({ cdp: async () => {
    if (fail) throw new Error("CDP unavailable");
  } });
  await assert.rejects(page.bridge.enable(), /CDP unavailable/);
  assert.equal(page.messages.listenerCount("message"), 0);
  fail = false;
  await page.bridge.enable();
  assert.equal(page.messages.listenerCount("message"), 1);
});

test("disposing during binding registration never leaves a listener behind", async () => {
  const pending = deferred();
  const page = watcher({ cdp: () => pending.promise });
  const enabled = page.bridge.enable();
  page.bridge.dispose();
  pending.resolve();
  await enabled;
  assert.equal(page.messages.listenerCount("message"), 0);
  page.signal(EVENTS, "closed");
  assert.deepEqual(page.copied, []);
});
