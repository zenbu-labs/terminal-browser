// Links for other apps, like Chrome's ExternalProtocolHandler: a page gets one "open another app" request per user
// interaction (the rest are refused unseen), and schemes Chrome never hands over are refused without asking.
// Nothing is ever handed to another app: every prompt is answered Block and shell.openExternal is replaced by a recorder.
const path = require("node:path");
const { BrowserWindow, shell } = require("electron");

const profile = process.env.PROBE_PROFILE;
for (const variable of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) {
  process.env[variable] = path.join(profile, variable.toLowerCase());
}
const launched = [];
shell.openExternal = async (url) => {
  launched.push(url);
};

const { PermissionPrompts } = require("../../dist/session/permissions.js");
const { watchExternalLaunchInput } = require("../../dist/browsing/external-launch-input.js");

require("./harness.cjs").run("external-protocol", async ({ ses, port, eq, sleep }) => {
  watchExternalLaunchInput();
  const prompts = new PermissionPrompts({ requestRender() {}, deviceAccess: async () => true });
  const asked = [];
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    if (permission !== "openExternal") return callback(false);
    const request = {
      permission,
      origin: new URL(details.requestingUrl).origin,
      embedder: new URL(details.requestingUrl).origin,
      mediaTypes: [],
      externalURL: details.externalURL,
      signal: new AbortController().signal,
    };
    prompts.request(1, request).then(callback, () => callback(false));
    setImmediate(() => {
      if (!prompts.hasPending(1)) return;
      asked.push(details.externalURL);
      prompts.decide(1, "block");
    });
  });
  const window = new BrowserWindow({ show: false, width: 400, height: 400, webPreferences: { offscreen: true } });
  const contents = window.webContents;
  await contents.loadURL(`http://127.0.0.1:${port}/page`);
  await contents.executeJavaScript(
    `document.body.innerHTML = '<a href="myapp://clicked" style="display:block;width:400px;height:400px">open</a>'; 1`,
  );
  await sleep(300);
  const go = async (url) => {
    await contents.executeJavaScript(`location.href = ${JSON.stringify(url)}; 1`);
    await sleep(500);
  };

  await go("myapp://first");
  await go("myapp://second");
  await go("myapp://third");
  eq(asked, ["myapp://first"], "without any interaction, only the first request is asked");

  contents.sendInputEvent({ type: "mouseDown", x: 100, y: 100, button: "left", clickCount: 1 });
  contents.sendInputEvent({ type: "mouseUp", x: 100, y: 100, button: "left", clickCount: 1 });
  await sleep(500);
  eq(asked, ["myapp://first", "myapp://clicked"], "a click on a link for another app is asked");

  await contents.executeJavaScript(`document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); 1`);
  await go("myapp://scripted");
  eq(asked.length, 2, "a click made by script doesn't count as an interaction");

  contents.sendInputEvent({ type: "rawKeyDown", keyCode: "a" });
  contents.sendInputEvent({ type: "keyUp", keyCode: "a" });
  await sleep(100);
  await go("shell:startup");
  contents.sendInputEvent({ type: "rawKeyDown", keyCode: "a" });
  contents.sendInputEvent({ type: "keyUp", keyCode: "a" });
  await sleep(100);
  await go("vbscript:msgbox");
  eq(asked.length, 2, "schemes Chrome never hands to another app aren't asked");
  eq(launched, [], "nothing was handed to another app");
  eq(contents.getURL(), `http://127.0.0.1:${port}/page`, "the page stayed where it was");
});
