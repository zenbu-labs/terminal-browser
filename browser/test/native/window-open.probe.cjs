// window.open from a page (patch 0035): the tab the browser opens for it loads as the opening frame's origin, so
// Chromium's own rules for that origin apply (another extension's private page is blocked, its web accessible page
// isn't), and the new page gets no opener and no user activation.
const { BrowserWindow } = require("electron");
const Module = require("node:module");

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "@zenbu-labs/pixel") return { initialWebViewState: (url) => ({ url, title: "", loading: true }) };
  return load.call(this, request, ...rest);
};
const { windowOpenRoute } = require("../../dist/pages/window-open.js");
const { TabManager } = require("../../dist/session/tabs.js");

require("./harness.cjs").run("window-open", async ({ ses, port, writeExtension, eq, sleep }) => {
  const caller = await ses.extensions.loadExtension(
    writeExtension("caller", port, {
      "manifest.json": { manifest_version: 3, name: "caller", version: "1" },
      "popup.html": "<!doctype html><title>popup</title>",
      "framed.html": `<!doctype html><title>framed</title><iframe src="http://127.0.0.1:${port}/page"></iframe>`,
      "options.html": "<!doctype html><title>options</title>",
    }),
  );
  const other = await ses.extensions.loadExtension(
    writeExtension("other", port, {
      "manifest.json": { manifest_version: 3, name: "other", version: "1", web_accessible_resources: [{ resources: ["open.html"], matches: ["<all_urls>"] }] },
      "private.html": "<!doctype html><title>private</title>",
      "open.html": "<!doctype html><title>open</title>",
    }),
  );
  const offscreen = { show: false, webPreferences: { offscreen: true } };

  const opens = async (openerUrl, target, { inFrame = false, script = (url) => `window.open(${JSON.stringify(url)})` } = {}) => {
    const opener = new BrowserWindow(offscreen);
    await opener.loadURL(openerUrl);
    await sleep(300);
    const outcome = new Promise((resolve) => {
      opener.webContents.setWindowOpenHandler((details) => {
        const route = windowOpenRoute(opener.webContents, details);
        if (!route) {
          resolve("refused");
          return { action: "deny" };
        }
        const tab = new BrowserWindow(offscreen);
        tab.webContents
          .loadURL(route.url, route.initiator ? { initiatorOrigin: route.initiator } : undefined)
          .then(
            () => tab.webContents.executeJavaScript(`[document.title, window.opener === null, navigator.userActivation.hasBeenActive].join(",")`),
            (error) => error.code ?? error.message,
          )
          .then(resolve);
        return { action: "deny" };
      });
    });
    const frame = inFrame ? opener.webContents.mainFrame.frames[0] : opener.webContents.mainFrame;
    await frame.executeJavaScript(script(target));
    return Promise.race([outcome, sleep(8000).then(() => "nothing opened")]);
  };

  const web = `http://127.0.0.1:${port}/page`;
  const popup = `${caller.url}popup.html`;
  const framed = `${caller.url}framed.html`;
  eq(await opens(web, `${other.url}private.html`), "ERR_BLOCKED_BY_CLIENT", "a web page opening another extension's private page");
  eq(await opens(web, `${other.url}open.html`), "open,true,false", "a web page opening a web accessible page");
  eq(await opens(web, "terminal-browser-file://file/tmp/x.html"), "refused", "a web page opening a local file");
  eq(await opens(web, "data:text/html,<title>data</title>"), "refused", "a web page opening a data URL");
  eq(await opens(web, "http://127.0.0.1:" + port + "/page?b", { script: (url) => `const a = document.createElement("a"); a.href = ${JSON.stringify(url)}; a.target = "_blank"; a.rel = "noopener"; document.body.append(a); a.click()` }), "probe,true,false", "a target=_blank link");
  eq(await opens(popup, `${caller.url}options.html`), "options,true,false", "an extension page opening its own page");
  eq(await opens(popup, `${other.url}private.html`), "ERR_BLOCKED_BY_CLIENT", "an extension page opening another extension's private page");
  eq(await opens(popup, "file:///etc/hosts"), "nothing opened", "an extension page opening a file URL");
  eq(await opens(framed, `${caller.url}options.html`, { inFrame: true }), "ERR_BLOCKED_BY_CLIENT", "a web frame in an extension page opening the extension's page");
  // Extension pages send no referrer, so with a web frame inside, the web frame's rules apply.
  eq(await opens(framed, `${caller.url}options.html`), "ERR_BLOCKED_BY_CLIENT", "an extension page with a web frame opening its own page");
  eq(await opens(framed, `http://127.0.0.1:${port}/page?c`), "probe,true,false", "an extension page with a web frame opening a web page");

  // window.open with features asks for a popup window instead of a tab; the tab's checks apply to it too.
  const external = [];
  const tabs = new TabManager(
    {
      onActivated() {},
      onActiveState() {},
      onPageMenu() {},
      onTabsChanged() {},
      onTabOpened() {},
      onOpenExternal: (_tab, route) => external.push(route.url),
      tabSwitchAllowed: () => true,
      requestRender() {},
    },
    "about:blank",
  );
  tabs.observer = { created() {}, ready() {}, updated() {}, activated() {}, moved() {}, pinned() {}, removed() {} };
  const page = new BrowserWindow(offscreen);
  await page.loadURL(web);
  const tab = tabs.create(web);
  const decisions = [];
  page.webContents.setWindowOpenHandler((details) => {
    decisions.push([details.url, details.disposition, tabs.openWindow(tab.id, details, page.webContents)]);
    return { action: "deny" };
  });
  const popups = ["data:text/html,<title>data</title>", "terminal-browser-file://file/etc/hosts", "terminal-browser://settings/", "myapp://open", `http://127.0.0.1:${port}/page?d`];
  for (const url of popups) await page.webContents.executeJavaScript(`window.open(${JSON.stringify(url)}, "p", "popup,width=300,height=300"); 1`);
  await sleep(500);
  eq(
    decisions.map(([url, disposition, decision]) => [url.slice(0, 22), disposition, decision]),
    popups.map((url) => [url.slice(0, 22), "new-window", url.startsWith("http:") ? "popup" : "deny"]),
    "popup windows a web page opens",
  );
  eq(external, ["myapp://open"], "a popup for another app goes to the prompt");
  eq(tabs.count, 1, "no tab opened");
});
