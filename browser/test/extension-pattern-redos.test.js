const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const Module = require("node:module");
const { test } = require("node:test");

// Each check runs in a child process, because a pattern that backtracks would
// freeze this one before any timeout could fire.
function runChild(name) {
  const run = spawnSync(process.execPath, [__filename, name], { encoding: "utf8", timeout: 15_000 });
  assert.equal(run.signal, null, `${name} hung`);
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

function timed(run) {
  const started = performance.now();
  const result = run();
  return { result, ms: performance.now() - started };
}

const children = {
  tabsQuery() {
    const load = Module._load;
    Module._load = function (request, ...rest) {
      if (request === "electron") return { ipcMain: { on() {}, handle() {} }, webContents: { fromId: () => null }, protocol: {}, app: { on() {} }, session: {} };
      if (request === "@zenbu-labs/pixel") return {};
      return load.call(this, request, ...rest);
    };
    const { installTabs } = require("../dist/extensions/api/tabs.js");
    const handlers = new Map();
    const titles = ["a".repeat(100_000), "God test page", "Hello*1234"];
    const window = { id: 1, host: { tabs: { all: () => titles.map((title, index) => ({ id: index, contentsId: index, title })) } } };
    const service = new Proxy(
      {
        router: { handle: (name, run) => handlers.set(name, run) },
        currentWindow: () => window,
        lastFocusedWindow: () => window,
        allWindows: () => [window],
        allPopupWindows: () => [],
        popupWindow: () => null,
        tabInfo: (_extension, { tab }) => ({ id: tab.id, title: tab.title, url: `https://x.example/${tab.title}` }),
      },
      { get: (target, key) => (key in target ? target[key] : () => ({ add() {} })) },
    );
    installTabs(service);
    const caller = { kind: "worker", extension: { id: "x" } };
    const query = (info) => timed(() => handlers.get("tabs.query")(caller, info).map((tab) => tab.id));
    return {
      titleGlob: query({ title: "*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b" }),
      urlGlob: query({ url: "https://*/*a*a*a*a*a*a*a*a*a*a*a*a*a*b" }),
      prefix: query({ title: "God test*" }),
      caseSensitive: query({ title: "god test*" }),
      questionMark: query({ title: "He??o\\*1*" }),
    };
  },

  urlFilter() {
    const { eventUrlFilterMatches, urlFilterMatches } = require("../dist/extensions/url-filter.js");
    const long = `https://e.x/${"a".repeat(100_000)}!`;
    return {
      poc: timed(() => urlFilterMatches({ urlMatches: "^https://e\\.x/(a|aa)+$" }, `https://e.x/${"a".repeat(40)}!`)),
      pocQuery: timed(() => urlFilterMatches({ urlMatches: "^https://example\\.com/\\?(x+x+)+y$" }, `https://example.com/?${"x".repeat(40)}`)),
      large: timed(() => urlFilterMatches({ urlMatches: "^https://e\\.x/(a|aa)+$" }, long)),
      largeOriginAndPath: timed(() => urlFilterMatches({ originAndPathMatches: "(a*)*b" }, long)),
      event: timed(() => eventUrlFilterMatches({ url: [{ urlMatches: "(a|aa)+$" }] }, long)),
      fullMatch: urlFilterMatches({ urlMatches: "^https://e\\.x/(a|aa)+$" }, "https://e.x/aaa"),
      partial: urlFilterMatches({ urlMatches: "e\\.x/a" }, "https://e.x/aaa?q#frag"),
      fragmentDropped: urlFilterMatches({ urlMatches: "#frag" }, "https://e.x/aaa?q#frag"),
      originAndPathDropsQuery: urlFilterMatches({ originAndPathMatches: "\\?q" }, "https://e.x/aaa?q"),
      caseSensitive: urlFilterMatches({ urlMatches: "E\\.X" }, "https://e.x/"),
      re2Flags: urlFilterMatches({ urlMatches: "(?i)E\\.X" }, "https://e.x/"),
      re2Class: urlFilterMatches({ urlMatches: "^https://\\pL+\\.x/$" }, "https://e.x/"),
      lookahead: urlFilterMatches({ urlMatches: "(?=https)" }, "https://e.x/"),
      backreference: urlFilterMatches({ urlMatches: "(h)\\1" }, "https://hh.x/"),
      invalid: urlFilterMatches({ urlMatches: "(" }, "https://e.x/"),
    };
  },
};

if (process.argv[2] in children) {
  process.stdout.write(JSON.stringify(children[process.argv[2]]()));
  process.exit(0);
} else {
  test("tabs.query title and url globs match like Chrome without backtracking", () => {
    const out = runChild("tabsQuery");
    for (const name of ["titleGlob", "urlGlob"]) {
      assert.deepEqual(out[name].result, [], name);
      assert.ok(out[name].ms < 50, `${name} took ${out[name].ms}ms`);
    }
    assert.deepEqual(out.prefix.result, [1]);
    assert.deepEqual(out.caseSensitive.result, []);
    assert.deepEqual(out.questionMark.result, [2]);
  });

  test("event filter regexes use Chrome's RE2 rules without backtracking", () => {
    const out = runChild("urlFilter");
    for (const name of ["poc", "pocQuery", "large", "largeOriginAndPath", "event"]) {
      assert.equal(out[name].result, false, name);
      assert.ok(out[name].ms < 50, `${name} took ${out[name].ms}ms`);
    }
    assert.equal(out.fullMatch, true);
    assert.equal(out.partial, true);
    assert.equal(out.fragmentDropped, false);
    assert.equal(out.originAndPathDropsQuery, false);
    assert.equal(out.caseSensitive, false);
    assert.equal(out.re2Flags, true);
    assert.equal(out.re2Class, true);
    assert.equal(out.lookahead, false);
    assert.equal(out.backreference, false);
    assert.equal(out.invalid, false);
  });
}
