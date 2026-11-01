// Dumps the chrome.* surface (every namespace/method/event/property) seen by
// the God extension's service worker, an extension page and a content script.
//   node surface.mjs chrome|tb > surface-<browser>.json
import fs from "node:fs";
import path from "node:path";
import { chromeDriver, tbDriver, sleep } from "./drivers.mjs";
import { startServer } from "./server.mjs";
import { OUT } from "./tb.mjs";

const which = process.argv[2];
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ids = JSON.parse(fs.readFileSync(path.join(ROOT, "extensions/ids.json"), "utf8"));
const GOD = path.join(ROOT, "extensions/god");
fs.mkdirSync(path.join(OUT, "profiles"), { recursive: true });

const server = await startServer();
const site = `http://localhost:${server.port}`;
const d = which === "chrome" ? await chromeDriver({ extensions: [GOD] }) : await tbDriver({ extensions: [GOD], startUrl: `${site}/page.html`, label: "surface" });
try {
  const base = `chrome-extension://${ids.god}/`;
  const sw = await d.evalIn(`${base}sw.js`, "JSON.stringify(globalThis.SURFACE)", 20000);
  if (which === "chrome") await d.openTab(`${site}/page.html`);
  await d.openTab(`${base}page.html`);
  await sleep(1500);
  const page = await d.evalIn(`${base}page.html`, "JSON.stringify(globalThis.SURFACE)");
  await sleep(1000);
  const cs = await d.evalIn((t) => t.url.startsWith(`${site}/page.html`) && t.type === "page", "document.documentElement.dataset.godCs || '{}'");
  const main = await d.evalIn((t) => t.url.startsWith(`${site}/page.html`) && t.type === "page", "document.documentElement.dataset.godMain || 'missing'");
  const out = { sw: JSON.parse(sw), page: JSON.parse(page), cs: JSON.parse(cs), main };
  const file = path.join(OUT, `surface-${which}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(file, Object.keys(out.sw).length, Object.keys(out.page).length, Object.keys(out.cs).length, main);
} finally {
  await d.stop();
  await server.close();
}
