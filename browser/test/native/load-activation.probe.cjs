// A load an extension starts goes through webContents.loadURL(url, { initiatorOrigin }) (patch 0035), which gives the
// current page no user activation. A plain loadURL activates it, both while the load is pending and after the page
// cancels the load from beforeunload.
const { BrowserWindow } = require("electron");
const http = require("node:http");

require("./harness.cjs").run("load-activation", async ({ ses, port, writeExtension, eq, sleep }) => {
  const extension = await ses.extensions.loadExtension(
    writeExtension("caller", port, { "manifest.json": { manifest_version: 3, name: "caller", version: "1" } }),
  );
  const slow = http.createServer((_req, res) => setTimeout(() => res.writeHead(200, { "Content-Type": "text/html" }).end("slow"), 1500));
  const slowPort = await new Promise((resolve) => slow.listen(0, "127.0.0.1", () => resolve(slow.address().port)));
  const page = `http://127.0.0.1:${port}/page`;
  const tab = new BrowserWindow({ show: false, width: 300, height: 300, webPreferences: { offscreen: true } });
  const contents = tab.webContents;
  const activation = () => contents.mainFrame.hasTransientUserActivation();
  await contents.loadURL(page);
  const clickedLongAgo = async () => {
    await contents.executeJavaScript("onbeforeunload = null; 1");
    await contents.loadURL(`${page}?clicked`);
    let clicked = false;
    for (let i = 0; i < 20 && !clicked; i++) {
      contents.sendInputEvent({ type: "mouseDown", x: 10, y: 10, button: "left", clickCount: 1 });
      contents.sendInputEvent({ type: "mouseUp", x: 10, y: 10, button: "left", clickCount: 1 });
      await sleep(200);
      clicked = activation();
    }
    await sleep(5500);
    return clicked;
  };
  const cancelledByPage = async (options) => {
    const clicked = await clickedLongAgo();
    await contents.executeJavaScript(`onbeforeunload = (e) => { e.preventDefault(); e.returnValue = ""; }; 1`);
    const before = activation();
    await contents.loadURL(`${page}?next`, options).catch(() => {});
    await sleep(300);
    return { clicked, before, after: activation(), url: contents.getURL() };
  };
  const whilePending = async (options) => {
    await contents.executeJavaScript("onbeforeunload = null; 1");
    await contents.loadURL(page);
    const done = contents.loadURL(`http://127.0.0.1:${slowPort}/`, options).catch(() => {});
    await sleep(300);
    const during = activation();
    await done;
    return { during, after: activation() };
  };

  eq(await cancelledByPage({ initiatorOrigin: extension.url }), { clicked: true, before: false, after: false, url: `${page}?clicked` }, "an extension's load the page cancels");
  eq(await cancelledByPage(undefined), { clicked: true, before: false, after: true, url: `${page}?clicked` }, "a plain load the page cancels");
  eq(await whilePending(undefined), { during: true, after: false }, "a plain load");
  eq(await whilePending({ initiatorOrigin: extension.url }), { during: false, after: false }, "an extension's load");

  const fresh = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await fresh.webContents.loadURL(`${page}?new`);
  eq(fresh.webContents.mainFrame.hasTransientUserActivation(), false, "a new tab's first page");
  slow.close();
});
