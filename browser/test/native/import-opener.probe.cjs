// The import page looks up other browsers' extensions right away only on a document the browser itself opened: a
// tab it created, a URL it loaded, or a link on one of its own pages. Every other document of the page, such as one an
// extension opened, a reload or back/forward, waits for Chromium's own activation from the user's input.
const { BrowserWindow, app, protocol } = require("electron");
const { navigateAsBrowser, openedAsBrowserTab, pageOpenedByBrowser, trackInternalPageOpener } = require("../../dist/pages/opened-by.js");
const { nextUserActivation } = require("../../dist/extensions/user-activation.js");

protocol.registerSchemesAsPrivileged([{ scheme: "terminal-browser", privileges: { standard: true, secure: true } }]);
app.on("web-contents-created", (_event, contents) => trackInternalPageOpener(contents));

const IMPORT = "terminal-browser://extensions/import";
const EXTENSIONS = "terminal-browser://extensions/";

require("./harness.cjs").run("import-opener", async ({ ses, port, writeExtension, eq, check, sleep }) => {
  ses.protocol.handle("terminal-browser", (request) =>
    new Response(
      new URL(request.url).pathname === "/import"
        ? "<!doctype html><title>import</title>"
        : `<!doctype html><body style="margin:0"><a href="${IMPORT}" style="display:block;width:100vw;height:100vh">import</a>`,
      { headers: { "content-type": "text/html" } },
    ),
  );
  const extension = await ses.extensions.loadExtension(
    writeExtension("opener", port, { "manifest.json": { manifest_version: 3, name: "opener", version: "1" } }),
  );
  const committed = (contents, url) => new Promise((resolve) => contents.on("did-navigate", (_event, at) => at === url && resolve()));
  const page = () => new BrowserWindow({ show: false, width: 400, height: 400, webPreferences: { offscreen: true } }).webContents;
  const click = (contents) => {
    contents.sendInputEvent({ type: "mouseDown", x: 50, y: 50, button: "left", clickCount: 1 });
    contents.sendInputEvent({ type: "mouseUp", x: 50, y: 50, button: "left", clickCount: 1 });
  };

  const browserTab = page();
  let startedDuringLoad = false;
  browserTab.once("did-start-navigation", () => (startedDuringLoad = true));
  const loading = browserTab.loadURL(IMPORT);
  const startedSynchronously = startedDuringLoad;
  openedAsBrowserTab(browserTab);
  await loading;
  eq(startedSynchronously, true, "a load the browser starts begins its navigation before loadURL returns");
  eq(pageOpenedByBrowser(browserTab), true, "a tab the browser opened");

  const [first, second] = [page(), page()];
  await Promise.all([first.loadURL(IMPORT), second.loadURL(IMPORT)]);
  eq([pageOpenedByBrowser(first), pageOpenedByBrowser(second)], [false, false], "two tabs an extension opened on the same URL");

  const imported = browserTab.mainFrame.documentId;
  await browserTab.loadURL(`http://127.0.0.1:${port}/page`);
  const back = committed(browserTab, IMPORT);
  browserTab.navigationHistory.goBack();
  await back;
  check(browserTab.mainFrame.documentId !== "", "the page has a document id");
  console.log(`  back/forward cache restored the same document: ${browserTab.mainFrame.documentId === imported}`);
  eq(pageOpenedByBrowser(browserTab), false, "back to the import page after navigating away");

  navigateAsBrowser(browserTab, () => void browserTab.loadURL(IMPORT));
  await committed(browserTab, IMPORT);
  eq(pageOpenedByBrowser(browserTab), true, "a URL the browser loaded");

  const reloaded = committed(browserTab, IMPORT);
  browserTab.reload();
  await reloaded;
  eq(pageOpenedByBrowser(browserTab), false, "after a reload");

  navigateAsBrowser(browserTab, () => void browserTab.loadURL(EXTENSIONS));
  await committed(browserTab, EXTENSIONS);
  await sleep(300);
  const linked = committed(browserTab, IMPORT);
  click(browserTab);
  await linked;
  eq(pageOpenedByBrowser(browserTab), true, "a link the user clicked on the browser's own page");

  const fromExtension = page();
  await fromExtension.loadURL(`http://127.0.0.1:${port}/page`);
  await fromExtension.loadURL(IMPORT, { initiatorOrigin: extension.url }).catch(() => {});
  eq(pageOpenedByBrowser(fromExtension), false, "a load started from an extension's origin");

  let resolved = null;
  const waiting = nextUserActivation(first).then((value) => (resolved = value));
  await sleep(300);
  first.sendInputEvent({ type: "mouseMove", x: 50, y: 50 });
  await sleep(300);
  eq(resolved, null, "pointer movement doesn't count as the user's input");
  click(first);
  await Promise.race([waiting, sleep(2000)]);
  eq(resolved, true, "a real click on the page");

  await sleep(300);
  click(second);
  await sleep(300);
  eq(second.mainFrame.hasTransientUserActivation(), true, "the click activated the page");
  const reloadedSecond = committed(second, IMPORT);
  second.reload();
  await reloadedSecond;
  eq(await Promise.race([nextUserActivation(second), sleep(1000).then(() => "pending")]), "pending", "a click on the page before it reloaded");
  const replaced = nextUserActivation(second);
  const reloadedAgain = committed(second, IMPORT);
  second.reload();
  await reloadedAgain;
  click(second);
  eq(await Promise.race([replaced, sleep(2000).then(() => "pending")]), false, "waiting on a page that was then replaced");
});
