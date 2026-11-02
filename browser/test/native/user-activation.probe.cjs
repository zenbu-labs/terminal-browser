// WebFrameMain.hasTransientUserActivation() (patch 0041) is Chromium's own per-frame activation: real input gives
// it to the frame the user used (and the frames around it), script-made events don't, and it expires.
const { BrowserWindow } = require("electron");

require("./harness.cjs").run("user-activation", async ({ port, eq, sleep }) => {
  const window = new BrowserWindow({ show: false, width: 400, height: 400, webPreferences: { offscreen: true } });
  const contents = window.webContents;
  await contents.loadURL(
    `data:text/html,<body style="margin:0"><iframe src="http://localhost:${port}/page" style="position:absolute;left:200px;top:0;width:200px;height:200px;border:0"></iframe></body>`,
  );
  await sleep(500);
  const top = contents.mainFrame;
  const child = top.frames[0];
  const click = async (x, y) => {
    contents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    contents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    await sleep(200);
  };

  eq([top.hasTransientUserActivation(), child.hasTransientUserActivation()], [false, false], "before any input");
  await top.executeJavaScript(`document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); 1`);
  await child.executeJavaScript(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true })); 1`);
  await sleep(200);
  eq([top.hasTransientUserActivation(), child.hasTransientUserActivation()], [false, false], "after script-made events");

  await click(50, 50);
  eq([top.hasTransientUserActivation(), child.hasTransientUserActivation()], [true, false], "after a click in the top frame");

  const other = new BrowserWindow({ show: false, width: 400, height: 400, webPreferences: { offscreen: true } });
  await other.webContents.loadURL(contents.getURL());
  await sleep(500);
  other.webContents.sendInputEvent({ type: "mouseDown", x: 250, y: 50, button: "left", clickCount: 1 });
  other.webContents.sendInputEvent({ type: "mouseUp", x: 250, y: 50, button: "left", clickCount: 1 });
  await sleep(200);
  eq(
    [other.webContents.mainFrame.hasTransientUserActivation(), other.webContents.mainFrame.frames[0].hasTransientUserActivation()],
    [true, true],
    "after a click in the iframe, which also activates the page around it",
  );

  await sleep(5500);
  eq(top.hasTransientUserActivation(), false, "five seconds later");
});
