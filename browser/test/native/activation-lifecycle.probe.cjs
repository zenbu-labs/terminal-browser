// While a page's unload handler runs, Chromium still answers hasTransientUserActivation() for it, so the gate
// must also look at the document's lifecycle.
const { BrowserWindow, webFrameMain } = require("electron");
const { hasTransientUserActivation } = require("../../dist/extensions/user-activation.js");

require("./harness.cjs").run("activation-lifecycle", async ({ port, check, eq, sleep }) => {
  const window = new BrowserWindow({ show: false, width: 400, height: 400, webPreferences: { offscreen: true } });
  const contents = window.webContents;
  await contents.loadURL(`http://localhost:${port}/page`);
  await contents.executeJavaScript(`addEventListener("unload", () => { const end = Date.now() + 4000; while (Date.now() < end); }); 1`);
  const { processId, frameToken } = contents.mainFrame;
  eq([contents.mainFrame.documentLifecycle, hasTransientUserActivation(contents.mainFrame)], ["active", false], "before navigating");

  const unloading = [];
  const watched = new Promise((resolve) => {
    contents.once("did-navigate", async () => {
      const started = Date.now();
      while (Date.now() - started < 3000) {
        contents.sendInputEvent({ type: "mouseDown", x: 50, y: 50, button: "left", clickCount: 1 });
        contents.sendInputEvent({ type: "mouseUp", x: 50, y: 50, button: "left", clickCount: 1 });
        await sleep(10);
        const old = webFrameMain.fromFrameToken(processId, frameToken);
        if (!old) break;
        if (old.hasTransientUserActivation()) unloading.push({ lifecycle: old.documentLifecycle, detached: old.detached, gate: hasTransientUserActivation(old) });
      }
      resolve();
    });
  });
  await contents.loadURL(`http://127.0.0.1:${port}/page`);
  await watched;

  check(unloading.length > 0, "the unloading page never reported an activation, so nothing was tested");
  eq(
    [...new Set(unloading.map((state) => JSON.stringify(state)))].map((state) => JSON.parse(state)),
    [{ lifecycle: "pending_deletion", detached: true, gate: false }],
    "the unloading page's activation, as the gate sees it",
  );
});
