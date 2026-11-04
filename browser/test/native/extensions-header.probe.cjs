// The extensions page header fits narrow panes: with Developer mode on nothing wraps mid-label or scrolls sideways,
// and turning Developer mode on or off moves nothing else on the page.
const http = require("node:http");
const { BrowserWindow } = require("electron");

const { pageHtml } = require("../../dist/pages/shell.js");

const extensions = ["Reading List", "Page Ruler"].map((name, i) => ({
  id: String.fromCharCode(97 + i).repeat(32), name, version: "2.3.0", enabled: true, errors: i ? [] : ["boom"],
  disabledReason: null, commands: [], icon: null,
}));

const stub = `window.terminalBrowser = {
  developerMode: false,
  list: async () => ({ developerMode: window.terminalBrowser.developerMode, extensions: ${JSON.stringify(extensions)} }),
  setDeveloperMode: async (on) => { window.terminalBrowser.developerMode = on; },
  onChange: () => {},
};`;

const measure = `(() => {
  const box = (node) => node.getBoundingClientRect();
  const lineHeight = parseFloat(getComputedStyle(document.body).lineHeight);
  const labels = [...document.querySelectorAll("header a, header .label > span, .subbar a, .subbar button")]
    .filter((node) => getComputedStyle(node).visibility !== "hidden" && !node.closest(".invisible"));
  return {
    sideways: document.documentElement.scrollWidth - innerWidth,
    wrapped: labels.filter((node) => box(node).height > lineHeight * 1.5).map((node) => node.textContent),
    clipped: labels.filter((node) => box(node).right > innerWidth).map((node) => node.textContent),
    toggle: box(document.querySelector("header .switch")).right <= innerWidth,
    rows: [...document.querySelectorAll("li.row")].map((row) => Math.round(box(row).top)),
    links: [...document.querySelectorAll("a")].map((link) => Math.round(box(link).top)),
  };
})()`;

require("./harness.cjs").run("extensions-header", async ({ eq, check, sleep }) => {
  const html = (await pageHtml({ title: "Extensions", theme: null, script: "extensions" }).text()).replace("<script nonce", `<script>${stub}</script><script nonce`);
  const server = http.createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(html));
  const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  // 640 and 750 CSS pixels are 1280 and 1500 pixel panes at the 2x scale the browser draws at; 400 is 800 pixels.
  for (const width of [750, 640, 400]) {
    const window = new BrowserWindow({ show: false, width, height: 600, useContentSize: true });
    await window.loadURL(`http://127.0.0.1:${port}/`);
    const page = window.webContents;
    await sleep(300);
    const off = await page.executeJavaScript(measure);
    await page.executeJavaScript(`document.querySelector("header .switch").click()`, true);
    await sleep(300);
    const on = await page.executeJavaScript(measure);
    check(await page.executeJavaScript(`!!document.getElementById("load-unpacked")?.checkVisibility()`), `${width}: Load unpacked shows in Developer mode`);
    for (const [mode, layout] of [["off", off], ["on", on]]) {
      eq(layout.sideways, 0, `${width}, Developer mode ${mode}: no sideways scroll`);
      eq(layout.wrapped, [], `${width}, Developer mode ${mode}: labels on one line`);
      eq(layout.clipped, [], `${width}, Developer mode ${mode}: nothing past the right edge`);
      check(layout.toggle, `${width}, Developer mode ${mode}: the toggle is in view`);
    }
    eq(on.rows, off.rows, `${width}: turning Developer mode on doesn't move the list`);
    eq(on.links, off.links, `${width}: turning Developer mode on doesn't move the links`);
    window.destroy();
  }
  server.close();
});
