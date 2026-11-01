// "Open link in new tab" on a page's link: the link opens as the frame it's in (Chrome uses the frame's origin as the
// initiator), so it can't reach local files, our pages or another extension's private page, and a link for another
// app opens no tab.
const { BrowserWindow } = require("electron");
const Module = require("node:module");

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "@zenbu-labs/pixel") return { initialWebViewState: (url) => ({ url, title: "", loading: true }) };
  return load.call(this, request, ...rest);
};
const { frameOpener } = require("../../dist/pages/window-open.js");
const { TabManager } = require("../../dist/session/tabs.js");

require("./harness.cjs").run("context-menu-open", async ({ ses, port, writeExtension, eq, sleep }) => {
  const other = await ses.extensions.loadExtension(
    writeExtension("other", port, {
      "manifest.json": { manifest_version: 3, name: "other", version: "1" },
      "private.html": "<!doctype html><title>private</title>",
    }),
  );
  const links = {
    file: "file:///etc/hosts",
    localFile: "terminal-browser-file://file/etc/hosts",
    ourPage: "terminal-browser://settings/",
    otherExtension: `${other.url}private.html`,
    web: `http://localhost:${port}/page`,
    otherApp: "myapp://open?x=1",
  };
  const anchors = Object.entries(links)
    .map(([name, url], i) => `<a href="${url}" style="position:absolute;left:0;top:${i * 40}px;width:300px;height:30px;display:block">${name}</a>`)
    .join("");
  const window = new BrowserWindow({ show: false, width: 400, height: 400, webPreferences: { offscreen: true } });
  const contents = window.webContents;
  await contents.loadURL(`http://127.0.0.1:${port}/page`);
  await contents.executeJavaScript(`document.body.innerHTML = ${JSON.stringify(anchors)}; 1`);
  await sleep(300);

  const opened = [];
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
  tabs.observer = { created: (tab) => opened.push(tab), ready() {}, updated() {}, activated() {}, moved() {}, pinned() {}, removed() {} };
  const opener = tabs.create(contents.getURL());

  const rightClick = async (y) => {
    const menu = new Promise((resolve) => contents.once("context-menu", (_event, params) => resolve(params)));
    contents.sendInputEvent({ type: "mouseDown", x: 20, y, button: "right", clickCount: 1 });
    contents.sendInputEvent({ type: "mouseUp", x: 20, y, button: "right", clickCount: 1 });
    return Promise.race([menu, sleep(5000).then(() => null)]);
  };

  const loads = async (tab) => {
    const loader = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    const result = await loader.webContents
      .loadURL(tab.url, tab.initiator ? { initiatorOrigin: tab.initiator } : undefined)
      .then(() => loader.webContents.executeJavaScript("document.title"), (error) => error.code ?? error.message);
    loader.destroy();
    return result;
  };

  const outcomes = {};
  for (const [i, name] of Object.keys(links).entries()) {
    const params = await rightClick(i * 40 + 15);
    const before = opened.length;
    const offered = params ? tabs.openLink(opener.id, frameOpener(params.frame), params.linkURL) : "no menu";
    const tab = opened.length > before ? opened.at(-1) : null;
    outcomes[name] = { linkURL: params?.linkURL, offered, initiator: tab?.initiator ?? null, loads: tab ? await loads(tab) : null };
  }
  const origin = `http://127.0.0.1:${port}`;
  eq(outcomes.file, { linkURL: links.file, offered: false, initiator: null, loads: null }, "a file:// link");
  eq(outcomes.localFile, { linkURL: links.localFile, offered: false, initiator: null, loads: null }, "a local file link");
  eq(outcomes.ourPage, { linkURL: links.ourPage, offered: false, initiator: null, loads: null }, "a link to our page");
  eq(outcomes.otherExtension, { linkURL: links.otherExtension, offered: true, initiator: origin, loads: "ERR_BLOCKED_BY_CLIENT" }, "another extension's private page");
  eq(outcomes.web, { linkURL: links.web, offered: true, initiator: origin, loads: "probe" }, "a web link");
  eq(outcomes.otherApp, { linkURL: links.otherApp, offered: true, initiator: null, loads: null }, "a link for another app");
  eq(external, [links.otherApp], "the link for another app goes to the prompt");
});
