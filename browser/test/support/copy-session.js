const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const shared = require("shared");
const { SettingsManager } = require("../../dist/session/settings.js");

async function copySession(t, text = "Page Ω 42") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-copy-session-"));
  const writes = [];
  const page = { text, activeElement: null, timeOrigin: 1 };
  const frame = {
    detached: false,
    url: "https://example.test",
    isDestroyed: () => false,
    executeJavaScript: async (source) => vm.runInNewContext(source, {
      document: { activeElement: page.activeElement, getSelection: () => page.text },
      getSelection: () => page.text,
      performance: { timeOrigin: page.timeOrigin },
    }),
  };
  const contents = { focusedFrame: frame, mainFrame: frame, isDestroyed: () => false };
  const handle = {
    webContents: contents,
    focus() {}, blur() {}, stopFind() {}, find() {}, findNext() {},
    cdp: async () => ({}),
  };
  let onKey;
  let view;
  let stopped = false;
  const root = {
    info: { width: 1200, height: 800, basePx: 16, cellWidth: 8, cellHeight: 16, kittyKeyboard: true, colors: {} },
    displayScale: 1,
    registerFont: async () => 1,
    highlightTransmits: () => false,
    setClipboard: (value) => writes.push(value),
    setRender() {}, setLogFile() {}, setTitle() {}, setPointerShape() {}, setKeyCapture() {},
    stop() { stopped = true; },
    render(element) {
      view = element.props;
      for (const tab of view.tabViews) tab.ref.current = handle;
    },
  };
  const mocks = {
    electron: { screen: { getPrimaryDisplay: () => ({ displayFrequency: 60 }) } },
    "@zenbu-labs/pixel": { createRoot: (options) => { onKey = options.onKey; return root; } },
    "@zenbu-labs/pixel/terminal": { detect: () => null },
    shared: { ...shared, installedVersion: () => null, lastUrl: () => null, setLastUrl() {}, store: () => { throw new Error("no database"); } },
  };
  const files = {
    "assets.js": { bundledAsset: () => "/fixture/font.ttf" },
    "grab/grab.js": { reactGrabPreloadPath: () => "/fixture/preload.js" },
    "record/session.js": {},
    "registry.js": { Registry: class { setCdpPort() {} update() {} dispose() {} } },
    "ui/chrome.js": { Chrome: () => null },
    "pages/scheme.js": { HOME_URL: "https://example.test", START_URL: "terminal-browser://start", DOC_SCHEME: "terminal-browser-file" },
    "telemetry.js": { Telemetry: class { launched() {} used() {} } },
    "session/settings.js": { SettingsManager: class extends SettingsManager {
      constructor(host) { super(host, { settings: path.join(dir, "settings.json"), shortcuts: path.join(dir, "shortcuts.json") }); }
    } },
  };
  const dist = path.resolve(__dirname, "../../dist");
  const cache = new Map();
  function load(file) {
    const relative = path.relative(dist, file).split(path.sep).join("/");
    if (files[relative]) return files[relative];
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const localRequire = createRequire(file);
    const requireModule = (name) => {
      if (mocks[name]) return mocks[name];
      if (name.startsWith(".")) return load(localRequire.resolve(name));
      return localRequire(name);
    };
    const run = vm.runInThisContext(`(function(require,module,exports,__dirname,__filename){${fs.readFileSync(file, "utf8")}\n})`, { filename: file });
    run(requireModule, module, module.exports, path.dirname(file), file);
    return module.exports;
  }
  const { createSession } = load(path.join(dist, "session/session.js"));
  const session = createSession({ key: "copy-test", tty: "/fixture/tty", argv: ["https://example.test"], env: {}, cwd: dir, cdpPort: null, onClose() {} });
  t.after(() => { session.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await session.ready;
  return {
    writes, page, frame, contents, handle, root,
    get view() { return view; },
    get stopped() { return stopped; },
    press: (key, mods = {}) => onKey({ kind: "press", key, mods: { ctrl: false, alt: false, shift: false, super: false, ...mods } }),
    settle: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

module.exports = { copySession };
