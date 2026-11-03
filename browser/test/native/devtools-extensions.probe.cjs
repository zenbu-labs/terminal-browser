// DevTools extensions stay out of the app's own pages (patch 0042), as Chrome keeps them out of chrome:// pages: an
// extension's devtools_page isn't loaded while DevTools inspects one, and once loaded, inspectedWindow refuses to act
// on one with Chrome's error.
const { BrowserWindow, protocol } = require("electron");

protocol.registerSchemesAsPrivileged([
  { scheme: "probe-ui", privileges: { standard: true, secure: true } },
  { scheme: "probe-files", privileges: { standard: true, secure: true } },
]);

const SLOW_MS = 90000;

require("./harness.cjs").run("devtools-extensions", async ({ ses, port, waitReport, writeExtension, eq, check, sleep }) => {
  for (const scheme of ["probe-ui", "probe-files"]) {
    ses.protocol.handle(scheme, () => new Response("<!doctype html><title>ui</title>", { headers: { "content-type": "text/html" } }));
  }
  const dir = writeExtension("devtools", port, {
    "manifest.json": { manifest_version: 3, name: "devtools", version: "1", devtools_page: "devtools.html" },
    "devtools.html": `<script src="report.js"></script><script src="devtools.js"></script>`,
    "devtools.js": `const inspected = chrome.devtools.inspectedWindow;
      setInterval(() => inspected.eval("location.href", (result, error) => {
        if (!error) return report("eval@" + result, true);
        report("error:" + error.details, error);
        if (String(error.details) !== "Permission denied") return;
        inspected.getResources().then((resources) => report("resources", resources.length), (e) => report("resources", e.message));
        inspected.reload();
      }), 250);`,
  });
  const extension = await ses.extensions.loadExtension(dir);
  const page = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  const devtools = new BrowserWindow({ show: false });
  const contents = page.webContents;
  await contents.loadURL("probe-files://docs/notes");
  contents.setDevToolsWebContents(devtools.webContents);
  contents.openDevTools({ mode: "detach" });

  const until = async (predicate, ms = SLOW_MS) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await predicate()) return true;
    return false;
  };
  const frontendTookExtensions = () =>
    devtools.webContents
      .executeJavaScript("Boolean(window.DevToolsAPI?._addExtensionCallback) && DevToolsAPI._pendingExtensionDescriptors.length === 0")
      .catch(() => false);
  const devtoolsPageLoaded = () => devtools.webContents.mainFrame.framesInSubtree.some((frame) => frame.origin === `chrome-extension://${extension.id}`);
  check(await until(frontendTookExtensions), "DevTools never took the extension list");
  eq(await until(devtoolsPageLoaded, 5000), false, "devtools_page loaded while DevTools inspects an app page");

  const web = `http://127.0.0.1:${port}/page`;
  await contents.loadURL(web);
  check(await until(devtoolsPageLoaded), "devtools_page loads once the inspected page is a web page");
  check(await waitReport(`eval@${web}`, SLOW_MS), "inspectedWindow.eval on a web page");

  await contents.loadURL("probe-ui://settings/");
  let navigations = 0;
  contents.on("did-start-navigation", () => navigations++);
  eq(
    await waitReport("error:Permission denied", SLOW_MS),
    { code: "E_FAILED", description: "Operation failed: %s", details: ["Permission denied"], isError: true },
    "inspectedWindow.eval on an app page",
  );
  eq(await waitReport("resources", SLOW_MS), "DevTools API encountered an error", "inspectedWindow.getResources on an app page");
  await sleep(1500);
  eq(navigations, 0, "inspectedWindow.reload reloaded an app page");
  eq(await waitReport("eval@probe-ui://settings/", 500).then(() => true, () => false), false, "an eval ran in an app page");
  eq(contents.getURL(), "probe-ui://settings/", "inspected page after the refused calls");
});
