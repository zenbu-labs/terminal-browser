// With a popups "block" rule, a page opens a window only on the user's click or key press, like Chrome: one window
// per input, only for the document that got the input, and not after the frame navigated to a new document.
const { BrowserWindow } = require("electron");
const { listenForUserActivation } = require("../../dist/extensions/user-activation.js");
const { popupBlocked } = require("../../dist/extensions/api/content-settings.js");

require("./harness.cjs").run("popup-activation", async ({ ses, port, eq, sleep }) => {
  listenForUserActivation();
  const service = { session: ses, contentSettings: { ruleForPage: () => "block" } };
  const window = new BrowserWindow({ show: false, width: 400, height: 400, webPreferences: { offscreen: true } });
  const contents = window.webContents;
  let decisions = [];
  contents.setWindowOpenHandler((details) => {
    decisions.push(popupBlocked(service, contents, details) ? "blocked" : "allowed");
    return { action: "deny" };
  });
  const button = (script) =>
    `data:text/html,${encodeURIComponent(`<body style="margin:0"><button style="width:400px;height:400px" onclick="${script}">open</button>`)}`;
  const click = async () => {
    contents.sendInputEvent({ type: "mouseDown", x: 100, y: 100, button: "left", clickCount: 1 });
    contents.sendInputEvent({ type: "mouseUp", x: 100, y: 100, button: "left", clickCount: 1 });
    await sleep(500);
  };
  const take = () => {
    const taken = decisions;
    decisions = [];
    return taken;
  };
  const target = `http://127.0.0.1:${port}/page`;

  await contents.loadURL(button(`window.open('${target}?a', '_blank'); window.open('${target}?b', '_blank')`));
  await sleep(300);
  await click();
  eq(take(), ["allowed", "blocked"], "one click opens one window");

  await contents.executeJavaScript(`window.open(${JSON.stringify(target)}, "_blank"); 1`);
  eq(take(), ["blocked"], "a script with no click");

  await click();
  take();
  await contents.executeJavaScript(`setTimeout(() => window.open(${JSON.stringify(target)}, "_blank"), 300); 1`);
  await sleep(600);
  eq(take(), ["blocked"], "later on, once the click's window was opened");

  await contents.loadURL(button("1"));
  await sleep(300);
  await click();
  await contents.loadURL(`data:text/html,${encodeURIComponent(`<script>window.open(${JSON.stringify(target)}, "_blank")</script>`)}`);
  await sleep(500);
  eq(take(), ["blocked"], "a new document right after a click on the old one");

  await contents.loadURL(button(`window.open('${target}?c', '_blank')`));
  await sleep(300);
  await click();
  eq(take(), ["allowed"], "a click on the new document");
});
