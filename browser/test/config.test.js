const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { ConfigStore } = require("shared");
const { Keymap, parseChord, formatChord, chordFromEvent } = require("shared");
const { defaultKeys } = require("shared");
const { searchUrlFor, searchOrUrl } = require("../dist/url.js");
const { SEARCH_ENGINES, engineBySearch, parseSuggestions } = require("shared");
const { SettingsManager } = require("../dist/session/settings.js");
const { renderEnv, maxFps } = require("shared");

const press = (key, mods = {}) => ({
  key,
  kind: "press",
  mods: { super: false, ctrl: false, alt: false, shift: false, ...mods },
});

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-config-"));
  return new ConfigStore({
    settings: path.join(dir, "settings.json"),
    shortcuts: path.join(dir, "shortcuts.json"),
  });
}

test("chords parse modifier aliases and shifted symbols", () => {
  assert.deepEqual(parseChord("Cmd+Shift+F"), {
    super: true,
    ctrl: false,
    alt: false,
    shift: true,
    key: "f",
  });
  assert.deepEqual(parseChord("ctrl++"), parseChord("ctrl+shift+="));
  assert.equal(parseChord("ctrl+"), null);
  assert.equal(parseChord("bogus+x"), null);
  assert.equal(formatChord(parseChord("option+esc"), "linux"), "alt+escape");
  assert.equal(formatChord(parseChord("super+,"), "darwin"), "cmd+,");
});

test("events fold shifted symbols and ignore lone modifiers", () => {
  assert.equal(chordFromEvent(press("leftshift")), null);
  assert.deepEqual(chordFromEvent(press("+", { ctrl: true })), parseChord("ctrl+shift+="));
  assert.deepEqual(chordFromEvent(press(" ")), parseChord("space"));
});

test("keymap matches defaults, overrides, and unbinding", () => {
  const defaults = new Keymap({}, { noSuper: false });
  const [firstDefault] = defaultKeys("settings.open");
  assert.equal(defaults.match(press(parseChord(firstDefault).key, { ctrl: true })), "settings.open");
  assert.equal(defaults.binding("settings.open").modified, false);

  const custom = new Keymap({ "tab.close": ["ctrl+shift+w"], find: null }, { noSuper: false });
  assert.equal(custom.match(press("w", { ctrl: true, shift: true })), "tab.close");
  assert.equal(custom.binding("tab.close").modified, true);
  assert.deepEqual(custom.labels("find"), []);
  assert.equal(custom.match(press("f", { super: true, shift: true })), null);
});

test("keymap swaps super for alt when the terminal cannot report super", () => {
  const noSuper = new Keymap({}, { noSuper: true });
  const macNewTab = new Keymap({}, { noSuper: false }).match(press("t", { super: true }));
  if (macNewTab === "tab.new") {
    assert.equal(noSuper.match(press("t", { alt: true })), "tab.new");
    assert.equal(noSuper.match(press("t", { super: true })), null);
  }
  const forced = new Keymap({ palette: ["cmd+p"] }, { noSuper: true });
  assert.equal(forced.match(press("p", { super: true })), "palette");
});

test("keymap reports conflicts between commands sharing a chord", () => {
  const keymap = new Keymap({ "tab.close": ["ctrl+g"] }, { noSuper: false });
  assert.deepEqual(keymap.conflicts("tab.close"), ["grab.toggle"]);
  assert.deepEqual(keymap.conflicts("grab.toggle"), ["tab.close"]);
  assert.deepEqual(new Keymap({}, { noSuper: false }).conflicts("tab.close"), []);
});

test("config store round trips settings and shortcuts", () => {
  const store = tempStore();
  assert.deepEqual(store.load().errors, []);
  assert.equal(store.load().settings["search.engine"].includes("%s"), true);

  store.setSetting("search.engine", "https://duckduckgo.com/?q=%s");
  store.setSetting("search.suggestions", "off");
  assert.equal(store.load().settings["search.engine"], "https://duckduckgo.com/?q=%s");
  assert.equal(store.load().settings["search.suggestions"], "off");
  store.setSetting("search.suggestions", undefined);
  assert.equal(store.load().settings["search.suggestions"].includes("google"), true);

  store.setShortcut("tab.close", ["ctrl+shift+w"]);
  store.setShortcut("find", null);
  store.setShortcut("palette", ["ctrl+p", "alt+p"]);
  const raw = JSON.parse(fs.readFileSync(store.files.shortcuts, "utf8"));
  assert.deepEqual(raw, { "tab.close": "ctrl+shift+w", find: null, palette: ["ctrl+p", "alt+p"] });
  assert.deepEqual(store.load().shortcuts, {
    "tab.close": ["ctrl+shift+w"],
    find: null,
    palette: ["ctrl+p", "alt+p"],
  });
  store.setShortcut("find", undefined);
  assert.equal("find" in store.load().shortcuts, false);
});

test("config store keeps unknown keys and refuses to overwrite broken files", () => {
  const store = tempStore();
  fs.mkdirSync(path.dirname(store.files.settings), { recursive: true });
  fs.writeFileSync(store.files.settings, JSON.stringify({ "future.setting": 1, "search.engine": 5 }));
  const loaded = store.load();
  assert.equal(loaded.settings["search.engine"].includes("google"), true);
  assert.equal(loaded.errors.length, 1);
  assert.match(loaded.errors[0], /search\.engine/);
  store.setSetting("search.suggestions", "off");
  assert.equal(JSON.parse(fs.readFileSync(store.files.settings, "utf8"))["future.setting"], 1);
  store.setSetting("search.engine", undefined);
  assert.deepEqual(store.load().errors, []);

  fs.writeFileSync(store.files.shortcuts, "{ not json");
  const broken = store.load();
  assert.equal(broken.errors.length, 1);
  assert.equal(broken.shortcuts, null);
  assert.equal(broken.settings["search.suggestions"], "off");
  assert.throws(() => store.setShortcut("find", null));
  assert.equal(fs.readFileSync(store.files.shortcuts, "utf8"), "{ not json");
});

test("shortcuts report unknown commands and bad values but keep the rest", () => {
  const store = tempStore();
  fs.mkdirSync(path.dirname(store.files.shortcuts), { recursive: true });
  fs.writeFileSync(
    store.files.shortcuts,
    JSON.stringify({ "tab.clsoe": "ctrl+w", find: 7, palette: ["ctrl+p"] }),
  );
  const loaded = store.load();
  assert.deepEqual(loaded.shortcuts, { palette: ["ctrl+p"] });
  assert.equal(loaded.errors.length, 2);
  assert.match(loaded.errors[0], /tab\.clsoe/);
  assert.match(loaded.errors[1], /find/);
  store.setShortcut("find", null);
  assert.equal(JSON.parse(fs.readFileSync(store.files.shortcuts, "utf8")).find, null);
});

test("config store recognises its own writes until someone else edits the file", () => {
  const store = tempStore();
  assert.equal(store.ownContent("settings"), false);
  store.setSetting("search.suggestions", "off");
  assert.equal(store.ownContent("settings"), true);
  fs.writeFileSync(store.files.settings, JSON.stringify({ "search.suggestions": "on" }));
  assert.equal(store.ownContent("settings"), false);
});

// an ignored write leaves no trace on its own, so each one is paired with an external
// edit: the watcher settles both together and reports only the files it should
test("config watcher reports external edits and ignores the store's own writes", async () => {
  const store = tempStore();
  const changes = [];
  let arrived = () => {};
  const stop = store.watch((files) => {
    changes.push(files);
    arrived();
  });
  const nextChange = () =>
    new Promise((resolve, reject) => {
      const late = setTimeout(() => reject(new Error("the watcher never reported the edit")), 5000);
      arrived = () => {
        clearTimeout(late);
        resolve();
      };
    });
  try {
    let change = nextChange();
    store.setShortcut("find", null);
    fs.writeFileSync(store.files.settings, JSON.stringify({ "search.suggestions": "off" }));
    await change;
    assert.deepEqual(changes, [["settings"]]);

    change = nextChange();
    fs.writeFileSync(store.files.settings, JSON.stringify({ "search.suggestions": "off" }));
    fs.writeFileSync(store.files.shortcuts, JSON.stringify({ find: "ctrl+f" }));
    await change;
    assert.deepEqual(changes, [["settings"], ["shortcuts"]]);
  } finally {
    stop();
  }
});

test("search templates substitute the query", () => {
  const duck = searchUrlFor("https://duckduckgo.com/?q=%s&ia=web");
  assert.equal(duck("a b"), "https://duckduckgo.com/?q=a%20b&ia=web");
  assert.equal(searchUrlFor("https://kagi.com/search?q=")("x"), "https://kagi.com/search?q=x");
  assert.equal(searchOrUrl("hello world", undefined, duck), duck("hello world"));
  assert.equal(searchOrUrl("example.com", undefined, duck), "example.com");
});

test("suggestion feeds parse the OpenSearch array and the Ecosia object shapes", () => {
  assert.deepEqual(parseSuggestions('["term",["termites","terminal"]]'), ["termites", "terminal"]);
  assert.deepEqual(parseSuggestions('{"query":"term","suggestions":["terminix",7,"terms"]}'), ["terminix", "terms"]);
  assert.deepEqual(parseSuggestions("not json"), []);
  assert.deepEqual(parseSuggestions("[]"), []);
});

function tempManager() {
  const store = tempStore();
  const host = {
    requestRender() {},
    settingsChanged() {},
    toast() {},
    overlayOpened() {},
    overlayClosed() {},
    release: () => ({ version: "dev", latest: null, upgrade: "terminal-browser upgrade" }),
  };
  return { manager: new SettingsManager(host, store.files), store };
}

test("click on focus stays on unless the settings file turns it off", () => {
  const store = tempStore();
  assert.equal(store.load().settings["mouse.focusClick"], "on");
  store.setSetting("mouse.focusClick", "off");
  assert.equal(store.load().settings["mouse.focusClick"], "off");
  fs.writeFileSync(store.files.settings, JSON.stringify({ "mouse.focusClick": "maybe" }));
  const loaded = store.load();
  assert.equal(loaded.settings["mouse.focusClick"], "on");
  assert.equal(loaded.errors.length, 1);
  assert.match(loaded.errors[0], /mouse\.focusClick/);
});

test("recording shows the chord until enter commits it and escape drops it", () => {
  const { manager } = tempManager();
  manager.open();
  manager.actions.recordShortcut("find");
  assert.equal(manager.view().recording.keys, "");

  manager.recordKey(press("k", { ctrl: true }));
  assert.equal(manager.view().recording.keys, "ctrl+k");
  manager.recordKey(press("j", { ctrl: true, shift: true }));
  assert.equal(manager.view().recording.keys, "ctrl+shift+j");
  manager.recordKey(press("escape"));
  assert.equal(manager.view().recording, null);
  assert.notEqual(manager.keymap.label("find"), "ctrl+shift+j");

  manager.actions.recordShortcut("find");
  manager.recordKey(press("enter"));
  assert.notEqual(manager.view().recording, null);
  manager.recordKey(press("k", { ctrl: true }));
  manager.recordKey(press("enter"));
  assert.equal(manager.view().recording, null);
  assert.equal(manager.keymap.label("find"), "ctrl+k");
});

test("shortcuts with chords that do not parse are reported instead of silently unbinding", () => {
  const store = tempStore();
  fs.mkdirSync(path.dirname(store.files.shortcuts), { recursive: true });
  fs.writeFileSync(
    store.files.shortcuts,
    JSON.stringify({ find: "ctrll+f", palette: ["ctrl+p", "bogus++x"], "tab.new": "ctrl+t" }),
  );
  const loaded = store.load();
  assert.deepEqual(loaded.shortcuts, { "tab.new": ["ctrl+t"] });
  assert.equal(loaded.errors.length, 2);
  assert.match(loaded.errors[0], /find/);
  assert.match(loaded.errors[1], /palette › 1/);
  const keymap = new Keymap(loaded.shortcuts, { noSuper: false });
  assert.notEqual(keymap.label("find"), "");
});

test("render settings accept numbers or their named values and refuse the rest", () => {
  const store = tempStore();
  fs.writeFileSync(
    store.files.settings,
    JSON.stringify({ "render.fps": 60, "render.presenter": "patched" }),
  );
  const loaded = store.load();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.settings["render.fps"], "60");
  assert.equal(loaded.settings["render.presenter"], "patched");

  fs.writeFileSync(
    store.files.settings,
    JSON.stringify({ "render.fps": "fast", "render.transport": "usb" }),
  );
  const broken = store.load();
  assert.equal(broken.errors.length, 2);
  assert.equal(broken.settings["render.fps"], "display");
  assert.equal(broken.settings["render.transport"], "auto");
});

test("window.transparent defaults off, persists on, and refuses other values", () => {
  const store = tempStore();
  assert.equal(store.load().settings["window.transparent"], "off");

  store.setSetting("window.transparent", "on");
  const loaded = store.load();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.settings["window.transparent"], "on");

  fs.writeFileSync(store.files.settings, JSON.stringify({ "window.transparent": true }));
  const broken = store.load();
  assert.equal(broken.errors.length, 1);
  assert.equal(broken.settings["window.transparent"], "off");
});

test("render settings map to engine values and the startup env", () => {
  assert.equal(maxFps("display", 120), 120);
  assert.equal(maxFps("uncapped", 120), 0);
  assert.equal(maxFps("45", 120), 45);

  const { manager } = tempManager();
  assert.deepEqual(renderEnv((key) => manager.get(key)), {});
  manager.actions.set("render.presenter", "animation");
  manager.actions.set("render.transport", "inline");
  assert.deepEqual(renderEnv((key) => manager.get(key)), {
    TERMINAL_BROWSER_PRESENT: "animation",
    TERMINAL_BROWSER_FRAMES: "inline",
  });
});
