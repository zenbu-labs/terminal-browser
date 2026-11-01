// What extensions may not touch (patches 0039, 0040): the Web Store is never scriptable (content scripts,
// scripting.executeScript, chrome.debugger), and an extension's debugger client is Chromium's restricted one: it is
// refused on and detached from pages the extension may not debug, before they load, and can't use browser-wide
// methods, read cookies of restricted sites or open local files.
const { BrowserWindow, protocol } = require("electron");

protocol.registerSchemesAsPrivileged([{ scheme: "probe-ui", privileges: { standard: true, secure: true } }]);

require("./harness.cjs").run("extension-restrictions", async ({ ses, port, waitReport, writeExtension, eq, check, sleep }) => {
  ses.protocol.handle("probe-ui", () => new Response("<!doctype html><title>ui</title>", { headers: { "content-type": "text/html" } }));
  ses.protocol.handle("https", (request) =>
    new URL(request.url).hostname === "chromewebstore.google.com"
      ? new Response("<!doctype html><title>store</title>", { headers: { "content-type": "text/html" } })
      : new Response("", { status: 404 }),
  );
  const dir = writeExtension("restricted", port, {
    "manifest.json": {
      manifest_version: 3,
      name: "restricted",
      version: "1",
      permissions: ["scripting", "debugger"],
      host_permissions: ["<all_urls>"],
      background: { service_worker: "sw.js" },
      content_scripts: [{ matches: ["<all_urls>"], js: ["report.js", "cs.js"] }],
    },
    "cs.js": `report("cs:" + location.hostname, true);`,
    "sw.js": `importScripts("report.js");
      chrome.runtime.onMessage.addListener((tabId) => {
        chrome.scripting.executeScript({ target: { tabId }, func: () => 1 }).then(() => report("script", "allowed"), (e) => report("script", e.message));
      });`,
    "page.html": `<script src="page.js"></script>`,
    "page.js": `chrome.runtime.sendMessage(Number(location.hash.slice(1)));`,
  });
  const extension = await ses.extensions.loadExtension(dir);
  const other = await ses.extensions.loadExtension(
    writeExtension("other", port, { "manifest.json": { manifest_version: 3, name: "other", version: "1" }, "page.html": "other" }),
  );
  const open = async (url) => {
    const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await window.loadURL(url).catch(() => {});
    return window.webContents;
  };
  const outcome = (fn) => Promise.resolve().then(fn).then(() => "ok", (e) => e.message);

  const store = await open("https://chromewebstore.google.com/detail/x");
  await open(`http://127.0.0.1:${port}/page`);
  check(await waitReport("cs:127.0.0.1"), "content script on a normal page");
  await sleep(500);
  await open(`${extension.url}page.html#${store.id}`);
  eq(await waitReport("script"), "The extensions gallery cannot be scripted.", "scripting.executeScript on the Web Store");
  eq(await waitReport("cs:chromewebstore.google.com", 1000).then(() => "ran", () => "did not run"), "did not run", "content script on the Web Store");
  eq(await outcome(() => ses.extensions.createDebugger(extension.id, store).attach("1.3")), "The extensions gallery cannot be scripted.", "debugger on the Web Store");

  eq(
    await outcome(async () => ses.extensions.createDebugger(extension.id, await open(`${other.url}page.html`)).attach("1.3")),
    "Cannot access a chrome-extension:// URL of different extension",
    "debugger on another extension's page",
  );

  const page = await open(`http://127.0.0.1:${port}/page?debug`);
  const client = ses.extensions.createDebugger(extension.id, page);
  client.attach("1.3");
  eq((await client.sendCommand("Runtime.evaluate", { expression: "1 + 1" })).result.value, 2, "Runtime.evaluate on a normal page");
  check((await outcome(() => client.sendCommand("Target.createTarget", { url: "about:blank" }))) !== "ok", "Target.createTarget is refused");
  await ses.cookies.set({ url: "https://chromewebstore.google.com/", name: "store", value: "1" });
  await ses.cookies.set({ url: `http://127.0.0.1:${port}/`, name: "site", value: "1" });
  const { cookies } = await client.sendCommand("Network.getAllCookies");
  eq(cookies.map((c) => c.name).sort(), ["site"], "Network.getAllCookies leaves out cookies of sites the extension may not access");
  check((await outcome(() => client.sendCommand("Page.navigate", { url: "file:///etc/hosts" }))) !== "ok", "Page.navigate to a file without file access");
  eq(page.getURL(), `http://127.0.0.1:${port}/page?debug`, "page after the refused file navigation");

  const detached = new Promise((resolve) => client.once("detach", (_event, reason) => resolve(reason)));
  let loadedWhileAttached = false;
  page.once("did-finish-load", () => (loadedWhileAttached = client.isAttached()));
  await page.loadURL("probe-ui://settings/").catch(() => {});
  eq(await detached, "target closed", "detached when the page navigates to the app's own scheme");
  eq(loadedWhileAttached, false, "still attached when the restricted page loaded");
  check((await outcome(() => client.sendCommand("Runtime.evaluate", { expression: "1" }))) !== "ok", "commands after the detach");
});
