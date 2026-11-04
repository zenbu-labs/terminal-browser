// pixel cancels xhr to file:// and the browser vets sandboxed local pages' requests; both share one request listener,
// so opening and closing a local page must leave pixel's file guard in place.
const fs = require("node:fs");
const path = require("node:path");
const { BrowserWindow } = require("electron");

const pixelDir = path.dirname(require.resolve("@zenbu-labs/pixel/package.json", { paths: [path.join(__dirname, "../..")] }));
const { configureBrowserSession } = require(path.join(pixelDir, "dist/web/browser-session.js"));
const scheme = require("../../dist/pages/scheme.js");

scheme.registerScheme();

require("./harness.cjs").run("file-guard", async ({ ses, eq, check }) => {
  const dir = fs.mkdtempSync(path.join(process.env.PROBE_PROFILE, "files-"));
  fs.writeFileSync(path.join(dir, "secret.txt"), "secret");
  fs.writeFileSync(path.join(dir, "page.html"), "<!doctype html><title>file page</title>");
  fs.writeFileSync(path.join(dir, "local.html"), '<!doctype html><title>local</title><script src="local.js"></script>');
  fs.writeFileSync(path.join(dir, "local.js"), "document.title = 'local script ran';");
  configureBrowserSession(ses);
  scheme.servePages(() => ({ cwd: dir, theme: null }));

  const fileWindow = new BrowserWindow({ show: false, webPreferences: { session: ses } });
  await fileWindow.loadFile(path.join(dir, "page.html"));
  const fileXhr = () =>
    fileWindow.webContents.executeJavaScript(
      `new Promise((resolve) => { const x = new XMLHttpRequest(); x.onload = () => resolve("read " + x.responseText); x.onerror = () => resolve("cancelled"); x.open("GET", ${JSON.stringify(`file://${dir}/secret.txt`)}); x.send(); })`,
    );
  eq(await fileXhr(), "cancelled", "xhr to file:// before any local page");

  const localWindow = new BrowserWindow({ show: false, webPreferences: { session: ses } });
  await localWindow.loadURL(`terminal-browser-file://file${dir}/local.html`);
  for (let i = 0; i < 50 && localWindow.webContents.getTitle() !== "local script ran"; i++) await new Promise((r) => setTimeout(r, 100));
  eq(localWindow.webContents.getTitle(), "local script ran", "a sandboxed local page loads its own script");
  eq(await fileXhr(), "cancelled", "xhr to file:// while a local page is open");

  localWindow.destroy();
  await new Promise((r) => setTimeout(r, 300));
  eq(await fileXhr(), "cancelled", "xhr to file:// after the local page closed");
  check(!fileWindow.isDestroyed(), "file window still open");
  fileWindow.destroy();
});
