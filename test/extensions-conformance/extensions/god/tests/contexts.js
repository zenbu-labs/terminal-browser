// Checks that only make sense inside a particular extension page.
(() => {
  const { test } = god;

  test("context.chrome-namespaces", (t) => Object.keys(chrome).sort().join(","), { ctx: ["popup", "options", "sidepanel", "offscreen", "devtools", "devtools-panel"], sigLimit: 4000 });

  test("runtime.getContexts#self", async (t) => {
    const all = await chrome.runtime.getContexts({ documentUrls: [location.href] });
    t.ok(all.length >= 1, "own context missing");
    return all[0].contextType;
  }, { ctx: ["page", "popup", "options", "sidepanel"] });

  test("context.offscreen-runtime-only", (t) => `getContexts=${typeof chrome.runtime.getContexts} keys=${Object.keys(chrome.runtime).filter((k) => typeof chrome.runtime[k] === "function").sort().join(",")}`, { ctx: ["offscreen"] });

  test("tabs.getCurrent#options", async (t) => {
    const tab = await chrome.tabs.getCurrent();
    t.ok(tab?.url?.endsWith("/options.html"), `got ${godJson(tab)?.slice(0, 120)}`);
  }, { ctx: ["options"] });

  test("tabs.getCurrent#sidepanel", async (t) => {
    t.eq(await chrome.tabs.getCurrent(), undefined);
  }, { ctx: ["sidepanel"] });

  test("window.close#popup-closes", async () => "checked by harness", { ctx: ["popup"] });

  test("devtools.inspectedWindow.tabId", (t) => {
    t.type(chrome.devtools.inspectedWindow.tabId, "number");
  }, { ctx: ["devtools", "devtools-panel"] });

  test("devtools.inspectedWindow.eval", async (t) => {
    const [result, exception] = await new Promise((r) => chrome.devtools.inspectedWindow.eval("document.title", (res, exc) => r([res, exc])));
    t.eq(exception, undefined);
    return `title=${result}`;
  }, { ctx: ["devtools"] });

  test("devtools.inspectedWindow.eval#exception", async (t) => {
    const [, exc] = await new Promise((r) => chrome.devtools.inspectedWindow.eval("throw new Error('x')", (res, e) => r([res, e])));
    t.ok(exc, "no exception info");
    return t.keys(exc);
  }, { ctx: ["devtools"] });

  test("devtools.inspectedWindow.getResources", async (t) => {
    const res = await new Promise((r) => chrome.devtools.inspectedWindow.getResources(r));
    t.ok(res.length > 0, "none");
    return `types=${[...new Set(res.map((x) => x.type))].sort().join(",")}`;
  }, { ctx: ["devtools"] });

  test("devtools.panels.create", async (t) => {
    const panel = await new Promise((r) => chrome.devtools.panels.create("God", "icons/16.png", "devtools-panel.html", r));
    t.ok(panel && panel.onShown && panel.onHidden, "panel object");
    return `methods=${Object.keys(Object.getPrototypeOf(panel)).concat(Object.keys(panel)).sort().join(",")}`;
  }, { ctx: ["devtools"] });

  test("devtools.panels.themeName", (t) => {
    t.type(chrome.devtools.panels.themeName, "string");
    return chrome.devtools.panels.themeName;
  }, { ctx: ["devtools"] });

  test("devtools.panels.elements.createSidebarPane", async (t) => {
    const pane = await new Promise((r) => chrome.devtools.panels.elements.createSidebarPane("God pane", r));
    t.ok(pane && pane.setObject, "pane");
    pane.setObject({ god: true });
  }, { ctx: ["devtools"] });

  test("devtools.panels.sources.createSidebarPane", async (t) => {
    const pane = await new Promise((r) => chrome.devtools.panels.sources.createSidebarPane("God src", r));
    t.ok(pane, "pane");
  }, { ctx: ["devtools"] });

  test("devtools.panels.setOpenResourceHandler", (t) => {
    chrome.devtools.panels.setOpenResourceHandler(() => {});
  }, { ctx: ["devtools"] });

  test("devtools.panels.openResource", (t) => t.ok(typeof chrome.devtools.panels.openResource === "function"), { ctx: ["devtools"] });

  test("devtools.network.getHAR", async (t) => {
    const har = await new Promise((r) => chrome.devtools.network.getHAR(r));
    t.ok(har && Array.isArray(har.entries), "no entries");
    return "har";
  }, { ctx: ["devtools"] });

  test("devtools.network.onNavigated", async (t) => {
    const [url] = await t.event(chrome.devtools.network.onNavigated, () => chrome.devtools.inspectedWindow.reload({ ignoreCache: true }), { timeout: 8000 });
    t.ok(url.startsWith("http://localhost"), url);
  }, { ctx: ["devtools"] });

  test("devtools.network.onRequestFinished", async (t) => {
    const [req] = await t.event(chrome.devtools.network.onRequestFinished, () => chrome.devtools.inspectedWindow.eval("fetch('/echo-headers?devtools=1'), 1"), { timeout: 8000 });
    t.ok(req.request?.url, "no request");
    return "har entry";
  }, { ctx: ["devtools"] });

  test("devtools.recorder.registerRecorderExtensionPlugin", (t) => {
    t.ok(typeof chrome.devtools.recorder?.registerRecorderExtensionPlugin === "function", "missing");
  }, { ctx: ["devtools"] });

  test("devtools.performance.events", (t) => {
    t.ok(chrome.devtools.performance?.onProfilingStarted?.addListener, "missing");
  }, { ctx: ["devtools"] });

  test("devtools.languageServices", (t) => (chrome.devtools.languageServices ? "present" : "absent"), { ctx: ["devtools"] });
})();
