const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

// dist/pages/start.js reaches electron through scheme.js; stub the import so
// the pure render stays testable under plain node.
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return { protocol: {}, app: {} };
  return originalLoad.call(this, request, ...rest);
};

const {
  routeStartApi,
  startVariant,
  resolveSearchEngine,
  resolveSearchInput,
  suggestUrl,
  parseSuggestResponse,
} = require("../dist/pages/start-api.js");
const { SEARCH_ENGINES } = require("shared");
const { render } = require("../dist/pages/start.js");
const { normalizeUrl, searchOrUrl, searchUrlFor } = require("../dist/url.js");

const fakeData = () => ({
  ports: [{ port: 3000, command: "node" }],
  documents: [{ url: "terminal-browser-file://file/x.md", label: "x.md", age: "2d" }],
  pr: { url: "https://example.com/pull/1", title: "Fix it", number: 1 },
  searchEngine: SEARCH_ENGINES[0].search,
});

const route = (method, url) => routeStartApi(method, new URL(url));

test("start page and both data endpoints dispatch", () => {
  assert.deepEqual(route("GET", "terminal-browser://start"), { kind: "page", variant: "home" });
  assert.deepEqual(route("GET", "terminal-browser://start/"), { kind: "page", variant: "home" });
  assert.deepEqual(route("GET", "terminal-browser://start?data"), { kind: "data" });
  assert.deepEqual(route("GET", "terminal-browser://start/api/data"), { kind: "data" });
  assert.deepEqual(route("GET", "terminal-browser://start/api/data?data"), { kind: "data" });
});

test("dev host serves the same endpoints with a dev page variant", () => {
  assert.equal(startVariant(new URL("terminal-browser://start")), "home");
  assert.equal(startVariant(new URL("terminal-browser://start/")), "home");
  assert.equal(startVariant(new URL("terminal-browser://dev")), "dev");
  assert.equal(startVariant(new URL("terminal-browser://dev/")), "dev");
  assert.deepEqual(route("GET", "terminal-browser://dev"), { kind: "page", variant: "dev" });
  assert.deepEqual(route("GET", "terminal-browser://dev/"), { kind: "page", variant: "dev" });
  assert.deepEqual(route("GET", "terminal-browser://dev?data"), { kind: "data" });
  assert.deepEqual(route("GET", "terminal-browser://dev/api/data"), { kind: "data" });
  assert.deepEqual(route("GET", "terminal-browser://dev/api/suggest?q=git"), { kind: "suggest", query: "git" });
  assert.deepEqual(route("GET", "terminal-browser://dev/page.css"), { kind: "page-css" });
  assert.deepEqual(route("GET", "terminal-browser://dev/nope"), { kind: "not-found" });
  assert.deepEqual(route("POST", "terminal-browser://dev"), { kind: "not-found" });
});

test("suggest endpoint dispatches with the decoded query", () => {
  assert.deepEqual(route("GET", "terminal-browser://start/api/suggest?q=git"), {
    kind: "suggest",
    query: "git",
  });
  assert.deepEqual(route("GET", "terminal-browser://start/api/suggest?q="), { kind: "suggest", query: "" });
  assert.deepEqual(route("GET", "terminal-browser://start/api/suggest"), { kind: "suggest", query: "" });
  assert.deepEqual(route("POST", "terminal-browser://start/api/suggest?q=git"), { kind: "not-found" });
});

test("static page stylesheet dispatches by exact path", () => {
  assert.deepEqual(route("GET", "terminal-browser://start/page.css"), { kind: "page-css" });
  assert.deepEqual(route("POST", "terminal-browser://start/page.css"), { kind: "not-found" });
  assert.deepEqual(route("GET", "terminal-browser://start/icon.png"), { kind: "page-icon" });
  assert.deepEqual(route("POST", "terminal-browser://start/icon.png"), { kind: "not-found" });
  assert.deepEqual(route("GET", "terminal-browser://start/page.js"), { kind: "not-found" });
});

test("unknown methods and paths miss", () => {
  const cases = [
    ["GET", "terminal-browser://start/nope"],
    ["POST", "terminal-browser://start"],
    ["POST", "terminal-browser://start/api/bookmark/1"],
    ["PUT", "terminal-browser://start/api/data"],
    ["DELETE", "terminal-browser://start/api/data"],
    ["DELETE", "terminal-browser://start/api/bookmark"],
    ["DELETE", "terminal-browser://start/api/bookmark/"],
    ["DELETE", "terminal-browser://start/api/bookmark/abc"],
  ];
  for (const [method, url] of cases) assert.deepEqual(route(method, url), { kind: "not-found" }, `${method} ${url}`);
});

test("search engine falls back to the default template", () => {
  const engine = "https://duckduckgo.com/?q=%s";
  assert.equal(resolveSearchEngine(engine), engine);
  assert.equal(resolveSearchEngine(undefined), SEARCH_ENGINES[0].search);
  assert.equal(resolveSearchEngine(""), SEARCH_ENGINES[0].search);
  assert.equal(resolveSearchEngine(7), SEARCH_ENGINES[0].search);
});

test("search input navigates bare hosts and loopback over http", () => {
  const engine = SEARCH_ENGINES[0].search;
  assert.equal(resolveSearchInput("github.com", engine), "https://github.com/");
  assert.equal(resolveSearchInput("  example.com/path?q=1  ", engine), "https://example.com/path?q=1");
  assert.equal(resolveSearchInput("localhost:3000", engine), "http://localhost:3000/");
  assert.equal(resolveSearchInput("127.0.0.1:5173/app", engine), "http://127.0.0.1:5173/app");
  assert.equal(resolveSearchInput("https://example.com/a?b=c", engine), "https://example.com/a?b=c");
  assert.equal(resolveSearchInput("HTTPS://EXAMPLE.COM/Path", engine), "https://example.com/Path");
  assert.equal(resolveSearchInput("about:blank", engine), "about:blank");
  assert.equal(resolveSearchInput("", engine), "about:blank");
  assert.equal(resolveSearchInput("   ", engine), "about:blank");
});

test("search input sends queries through the engine template with encoding", () => {
  const engine = SEARCH_ENGINES[0].search;
  assert.equal(resolveSearchInput("rust async await", engine), `${engine.split("%s")[0]}rust%20async%20await`);
  assert.equal(resolveSearchInput("hello", engine), `${engine.split("%s")[0]}hello`);
  assert.equal(resolveSearchInput("a b&c=d", engine), `${engine.split("%s")[0]}a%20b%26c%3Dd`);
  assert.equal(resolveSearchInput("foo/bar", engine), `${engine.split("%s")[0]}foo%2Fbar`);
  assert.equal(resolveSearchInput("example.com:abc", engine), `${engine.split("%s")[0]}example.com%3Aabc`);
  assert.equal(
    resolveSearchInput("tab query", "https://kagi.com/search?q="),
    "https://kagi.com/search?q=tab%20query",
  );
});

test("search input matches the omnibox pipeline on url-like and query input", () => {
  const template = "https://duckduckgo.com/?q=%s";
  const search = searchUrlFor(template);
  const pipeline = (text) => normalizeUrl(searchOrUrl(text, undefined, search), undefined, search);
  const cases = [
    "github.com",
    "example.com/docs",
    "rust async await",
    "hello",
    "https://example.com/a?b=c",
    "http://localhost:3000/x",
    "localhost:3000",
    "foo/bar",
    "about:blank",
    "data:text/plain,hi",
  ];
  for (const text of cases) assert.equal(resolveSearchInput(text, template), pipeline(text), text);
});

test("suggest urls substitute the query and null hides the dropdown", () => {
  const google = SEARCH_ENGINES.find((engine) => engine.id === "google");
  assert.equal(suggestUrl(google.suggest, "rust as"), `${google.suggest.split("%s")[0]}rust%20as`);
  assert.equal(suggestUrl(null, "rust as"), null);
  const perplexity = SEARCH_ENGINES.find((engine) => engine.id === "perplexity");
  assert.equal(perplexity.suggest, null);
  assert.equal(suggestUrl(perplexity.suggest, "anything"), null);
});

test("suggest responses parse opensearch tuples and ecosia objects", () => {
  assert.deepEqual(parseSuggestResponse('["term",["termites","terminal"],[]]'), ["termites", "terminal"]);
  assert.deepEqual(parseSuggestResponse('{"query":"term","suggestions":["terminix",7,"terms"]}'), [
    "terminix",
    "terms",
  ]);
  assert.deepEqual(parseSuggestResponse("not json"), []);
  assert.deepEqual(parseSuggestResponse("[]"), []);
  assert.deepEqual(parseSuggestResponse('{"suggestions":[]}'), []);
});

test("served page fetches suggestions through the proxy, never the engine directly", () => {
  const pageJs = fs.readFileSync(path.join(__dirname, "..", "..", "assets", "start", "page.js"), "utf8");
  assert.match(pageJs, /\/api\/suggest\?q=" \+ encodeURIComponent\(query\)/);
  assert.doesNotMatch(pageJs, /fetch\(substitute\(suggestTemplate/);
  assert.match(pageJs, /(const|let|var) apiBase\s*=/);
  assert.match(pageJs, /label\.textContent = text/);
  assert.match(pageJs, /cloneNode\(true\)/);
  assert.match(pageJs, /createElementNS\("http:\/\/www\.w3\.org\/2000\/svg", "svg"\)/);
});

test("home render is hero plus footer with no dev sections", () => {
  const page = render(fakeData(), null, "home");
  assert.match(page, /id="search-form"/);
  assert.match(page, /<img src="\.\/icon\.png" alt="" width="30" height="30">/);
  assert.doesNotMatch(page, /<svg/);
  assert.match(page, /id="search-input"/);
  assert.match(page, /Enter opens here/);
  assert.match(page, /id="home-foot"/);
  assert.doesNotMatch(page, /<section>/);
  assert.doesNotMatch(page, /Running servers/);
  assert.doesNotMatch(page, /Recent documents/);
  assert.doesNotMatch(page, /Pull request/);
  assert.doesNotMatch(page, /no running servers/);
});

test("dev render keeps the dashboard sections byte-identical with no hero or footer", () => {
  const page = render(fakeData(), null, "dev");
  assert.match(page, /<section><h2>Pull request<\/h2>/);
  assert.match(page, /<section><h2>Running servers<\/h2>/);
  assert.match(page, /<section><h2>Recent documents<\/h2>/);
  assert.match(page, /localhost:3000/);
  assert.match(page, /#1 Fix it/);
  assert.doesNotMatch(page, /id="search-input"/);
  assert.doesNotMatch(page, /id="search-form"/);
  assert.doesNotMatch(page, /id="home-foot"/);
  assert.doesNotMatch(page, /Enter opens here/);
  assert.doesNotMatch(page, /class="hint"/);
});

test("dev empty state keeps the exact copy with no hero", () => {
  const empty = { ports: [], documents: [], pr: null, searchEngine: SEARCH_ENGINES[0].search };
  const page = render(empty, null, "dev");
  assert.match(page, /no running servers, no recent documents, no open pull request/);
  assert.doesNotMatch(page, /<section>/);
  assert.doesNotMatch(page, /id="search-input"/);
  const home = render(empty, null, "home");
  assert.doesNotMatch(home, /no running servers/);
  assert.match(home, /id="search-input"/);
});

test("scheme gate admits start and dev hosts only", () => {
  const scheme = fs.readFileSync(path.join(__dirname, "..", "src", "pages", "scheme.ts"), "utf8");
  assert.match(scheme, /url\.host !== "start" && url\.host !== "dev"/);
});

test("served page script parses as valid JavaScript", () => {
  const vm = require("node:vm");
  const page = render(fakeData(), null);
  const bodies = [...page.matchAll(/<script(?![^>]*type=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(bodies.length > 0, "expected at least one inline classic script");
  for (const [i, body] of bodies.entries()) new vm.Script(body, { filename: `start-page-${i}.js` });
});

test("page script polls only where dev sections exist and survives missing hero DOM", () => {
  const vm = require("node:vm");
  const pageJs = fs.readFileSync(path.join(__dirname, "..", "..", "assets", "start", "page.js"), "utf8");

  const run = ({ hero, sections, empty }) => {
    const intervals = [];
    const fetches = [];
    const docHandlers = {};
    let focused = false;
    const el = (id, dataset) => ({
      id,
      dataset: dataset ?? {},
      value: "",
      hidden: true,
      replaceChildren() {},
      appendChild() {},
      remove() {},
      click() {},
      focus() {
        focused = true;
      },
      setAttribute() {},
      addEventListener() {},
    });
    const elements = hero
      ? {
          "search-input": el("search-input", { searchTemplate: "https://duckduckgo.com/?q=%s" }),
          "search-suggest": el("search-suggest"),
          "search-form": el("search-form"),
        }
      : {};
    const sandbox = {
      document: {
        getElementById: (id) => elements[id] ?? null,
        querySelector: (selector) => {
          const wants = String(selector)
            .split(",")
            .map((part) => part.trim());
          if (wants.includes("section") && sections) return {};
          if (wants.includes(".empty") && empty) return {};
          return null;
        },
        createElement: () => el("dynamic"),
        createElementNS: () => el("dynamic"),
        addEventListener: (type, fn) => {
          docHandlers[type] = fn;
        },
        activeElement: null,
        body: { appendChild() {} },
      },
      window: {},
      location: { origin: "terminal-browser://dev", pathname: "/", href: "", reload() {} },
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      fetch: () => {
        fetches.push(1);
        return Promise.resolve({ ok: true, text: () => Promise.resolve("[]") });
      },
      setInterval: (fn) => {
        intervals.push(fn);
        return intervals.length;
      },
      setTimeout: () => 0,
      clearTimeout: () => {},
      scrollTo: () => {},
      scrollX: 0,
      scrollY: 0,
      HTMLInputElement: class {},
      HTMLTextAreaElement: class {},
      HTMLSelectElement: class {},
      HTMLElement: class {},
      AbortController: class {
        abort() {}
        signal = {};
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(pageJs, sandbox, { filename: "page.js" });
    return { intervals, fetches, docHandlers, wasFocused: () => focused };
  };

  const home = run({ hero: true, sections: false, empty: false });
  assert.equal(home.fetches.length, 0);
  assert.equal(home.intervals.length, 0);

  const dev = run({ hero: false, sections: true, empty: false });
  assert.equal(dev.fetches.length, 1);
  assert.equal(dev.intervals.length, 1);

  const devEmpty = run({ hero: false, sections: false, empty: true });
  assert.equal(devEmpty.fetches.length, 1);
  assert.equal(devEmpty.intervals.length, 1);

  assert.doesNotThrow(() =>
    dev.docHandlers.keydown({ key: "/", ctrlKey: false, metaKey: false, altKey: false, target: {} }),
  );
  home.docHandlers.keydown({
    key: "/",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    target: {},
    preventDefault: () => {},
  });
  assert.equal(home.wasFocused(), true);
});

test("served page has no unreplaced asset slots, and hostile island data passes through literally", () => {
  const slotPattern = () => new RegExp("\\{\\{[a-zA-Z_]+\\}\\}");
  const empty = { ports: [], documents: [], pr: null, searchEngine: SEARCH_ENGINES[0].search };
  for (const page of [
    render(fakeData(), null, "home"),
    render(empty, null, "home"),
    render(fakeData(), null, "dev"),
    render(empty, null, "dev"),
  ]) {
    assert.doesNotMatch(page, slotPattern());
  }
  const hostile = fakeData();
  hostile.pr = { url: "https://example.com/pull/9", title: "{{PAGE_JS}} $& broke", number: 9 };
  hostile.ports = [{ port: 8080, command: "{{DEV}} $&" }];
  const hostileHtml = render(hostile, null, "dev");
  assert.match(hostileHtml, /\$&/);
  assert.match(hostileHtml, new RegExp("\\{\\{PAGE_JS\\}\\}"));
});

test("start css is fully static valid CSS with terminal colors as variables", () => {
  const startCss = fs.readFileSync(path.join(__dirname, "..", "..", "assets", "start", "page.css"), "utf8");
  assert.doesNotMatch(startCss, /\{\{[a-zA-Z_]+\}\}/);
  for (const name of ["fg", "muted", "accent", "hairline", "field"]) {
    assert.match(startCss, new RegExp(`var\\(--${name}\\)`), name);
  }
});

test("served page links the static stylesheet and carries per-terminal vars inline", () => {
  const page = render(fakeData(), null);
  assert.match(page, /<link rel="stylesheet" href="\.\/page\.css">/);
  assert.match(page, /<style>:root\{--fg:[^;]+;--muted:[^;]+;--accent:[^;]+;--hairline:[^;]+;--field:[^;]+;\}<\/style>/);
});
