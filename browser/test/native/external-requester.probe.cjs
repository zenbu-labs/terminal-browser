// The open-another-app prompt names who asked, like Chrome's external protocol dialog: a sandboxed frame by the site
// that made it, a local file as file://, never the page around a frame. Sandboxed frames without a sandbox escape
// can't ask at all.
// Nothing is ever handed to another app: shell.openExternal is replaced, and every prompt is answered Block.
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { BrowserWindow, shell } = require("electron");

for (const variable of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) {
  process.env[variable] = path.join(process.env.PROBE_PROFILE, variable.toLowerCase());
}
shell.openExternal = async () => {};

const scheme = require("../../dist/pages/scheme.js");
const { windowOpenRoute } = require("../../dist/pages/window-open.js");
const { PermissionPrompts } = require("../../dist/session/permissions.js");
const { permitExternalLaunch } = require("../../dist/browsing/external-protocol.js");

scheme.registerScheme();

const doc = (file) => `terminal-browser-file://file${file.split("/").map(encodeURIComponent).join("/")}`;

require("./harness.cjs").run("external-requester", async ({ ses, eq, sleep }) => {
  const sites = {};
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const body = url.searchParams.get("body") ?? "";
    res.writeHead(200, { "Content-Type": "text/html" }).end(`<!doctype html><title>${req.headers.host}</title>${body}`);
  });
  const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  sites.top = `http://127.0.0.1:${port}`;
  sites.ads = `http://localhost:${port}`;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.PROBE_PROFILE, "files-")));
  fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><title>local</title>");
  scheme.servePages(() => ({ cwd: root, theme: null }));

  const prompts = new PermissionPrompts({ requestRender() {}, deviceAccess: async () => true, extensionHasPermission: () => false });
  const shown = [];
  const ask = (origin, externalURL) => {
    permitExternalLaunch();
    const request = { permission: "openExternal", origin, embedder: sites.top, mediaTypes: [], externalURL, signal: new AbortController().signal };
    const answer = prompts.request(1, request);
    shown.push(prompts.hasPending(1) ? prompts.view(1).host : "not asked");
    prompts.decide(1, "block");
    return answer;
  };

  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    if (permission !== "openExternal") return callback(false);
    const origin = details.requestingUrl ? new URL(details.requestingUrl).origin : "";
    ask(origin, details.externalURL).then(callback, () => callback(false));
  });

  const offscreen = { show: false, webPreferences: { offscreen: true, session: ses } };
  const launch = async (pageUrl, script, frameIndex = null) => {
    shown.length = 0;
    const page = new BrowserWindow(offscreen);
    const contents = page.webContents;
    contents.setWindowOpenHandler((details) => {
      const route = windowOpenRoute(contents, details);
      if (!route?.external) shown.push("refused");
      else ask(route.external.requester, route.url);
      return { action: "deny" };
    });
    await contents.loadURL(pageUrl);
    await sleep(400);
    const frame = frameIndex === null ? contents.mainFrame : contents.mainFrame.frames[frameIndex];
    await frame.executeJavaScript(script).catch(() => {});
    await sleep(600);
    page.destroy();
    return [...shown];
  };
  const framed = (sandbox) =>
    `${sites.top}/?body=${encodeURIComponent(`<iframe ${sandbox === null ? "" : `sandbox="${sandbox}"`} src="${sites.ads}/"></iframe>`)}`;
  const open = `window.open("zoommtg://zoom.us/join"); 1`;
  const navigate = `location.href = "zoommtg://zoom.us/join"; 1`;

  eq(await launch(framed("allow-scripts allow-popups"), open, 0), ["localhost:" + port], "a sandboxed frame's window.open names the frame's site");
  eq(await launch(framed(null), open, 0), ["localhost:" + port], "a cross-origin frame's window.open names the frame, not the page");
  eq(await launch(framed("allow-scripts"), open, 0), [], "a sandboxed frame without allow-popups can't ask");
  eq(await launch(framed("allow-scripts"), navigate, 0), [], "a sandboxed frame without a sandbox escape can't navigate to another app");
  eq(await launch(framed("allow-scripts allow-top-navigation-to-custom-protocols"), navigate, 0), ["localhost:" + port], "a sandboxed frame with a sandbox escape is named by its site, not the page's");
  eq(await launch(`${sites.top}/`, open), ["127.0.0.1:" + port], "the page itself is named");
  eq(await launch(doc(path.join(root, "index.html")), open), ["file://"], "a local file asks as file://");
  server.close();
});
