// Checks that need a person: gestures, keyboard shortcuts, the omnibox,
// context menus, devtools. Gestures go through CDP input in both browsers;
// keyboard/menu/omnibox go through terminal-browser's real input path (pixel)
// and can't be driven in headless Chrome, so those have no Chrome reference.
import { clickElement } from "./drivers.mjs";

export async function interact(d, { which, site, ids, base, sleep, log }) {
  const results = [];
  const SW = (t) => t.type === "service_worker" && t.url === `${base}sw.js`;
  const events = async (name) => JSON.parse(await d.evalIn(SW, `JSON.stringify(godEvents[${JSON.stringify(name)}] ?? [])`));
  const push = (id, ok, sig, note = "") => results.push({ id, ctx: "interactive", ok, sig: String(sig).slice(0, 300), note });
  const waitFor = async (fn, timeout = 6000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = await fn().catch(() => null);
      if (v) return v;
      await sleep(250);
    }
    return null;
  };
  const pageMatch = (t) => t.type === "page" && t.url.startsWith(`${base}page.html`);

  log("  side panel via user gesture");
  try {
    await clickElement(d, pageMatch, "#open-panel");
    const opened = await waitFor(() => d.evalIn(pageMatch, "document.getElementById('gesture-out').dataset.panel || null"));
    push("sidePanel.open#gesture", opened === "opened", opened ?? "no result");
    const panel = await waitFor(() => d.evalIn((t) => t.url.startsWith(`${base}sidepanel.html`), "globalThis.god?.done ? JSON.stringify(god.results) : null", 2000), 10000);
    if (panel) results.push(...JSON.parse(panel));
    else push("context.sidepanel", false, "side panel context never ran");
    const ev = await events("sidePanel.onOpened");
    push("sidePanel.onOpened", ev.length > 0, ev.length ? `keys=${Object.keys(ev[0][0] ?? {}).sort().join(",")} path=${ev[0][0]?.path?.replace(/^chrome-extension:\/\/[a-p]+/, "EXT")}` : "not fired");
    const closed = await d.evalIn(SW, `chrome.windows.getCurrent().then((w) => chrome.sidePanel.close({ windowId: w.id })).then(() => "closed", (e) => "rejects: " + e.message)`);
    await sleep(600);
    const cev = await events("sidePanel.onClosed");
    push("sidePanel.close+onClosed", closed === "closed" && cev.length > 0, `${closed} onClosed=${cev.length}`);
  } catch (error) {
    push("sidePanel.open#gesture", false, `harness: ${error.message}`);
  }

  log("  permissions.request via user gesture");
  try {
    await clickElement(d, pageMatch, "#request-permission");
    const r = await waitFor(() => d.evalIn(pageMatch, "document.getElementById('gesture-out').dataset.request || null"), 4000);
    push("permissions.request#gesture-already-granted", !!r, r ?? "pending (prompt shown)");
  } catch (error) {
    push("permissions.request#gesture-already-granted", false, `harness: ${error.message}`);
  }

  log("  popup");
  const popup = await d.evalIn(SW, "JSON.stringify(godContextResults.popup ?? null)").then(JSON.parse);
  if (popup) results.push(...popup);
  else push("context.popup", false, "popup context never ran (action.openPopup did not open a popup)");

  log("  offscreen");
  const offscreen = await d.evalIn(SW, "JSON.stringify(godContextResults.offscreen ?? null)").then(JSON.parse);
  if (offscreen) results.push(...offscreen);
  else push("context.offscreen", false, "offscreen context never reported");

  log("  devtools");
  if (which === "tb") {
    const tb = d.tb;
    await tb.control("activate-tab", { url: `${site}/page.html` }).catch(() => {});
    await sleep(500);
    await tb.key("i", { mods: { super: true, shift: true } });
  }
  const devtools = await waitFor(async () => JSON.parse(await d.evalIn(SW, "JSON.stringify(godContextResults.devtools ?? null)")), 15000);
  if (devtools) results.push(...devtools);
  else push("context.devtools", false, "devtools_page never ran");

  if (which !== "tb") return results;
  const tb = d.tb;

  log("  commands");
  await tb.key("y", { mods: { alt: true, shift: true } });
  const cmd = await waitFor(async () => (await events("commands.onCommand"))[0], 4000);
  push("commands.onCommand#shortcut", cmd?.[0] === "god-command", cmd ? JSON.stringify(cmd) : "not fired");

  log("  omnibox");
  await tb.key("l", { mods: { super: true } });
  await sleep(300);
  await tb.type("god ");
  await sleep(500);
  await tb.type("hello");
  await sleep(800);
  await tb.key("enter");
  await sleep(1200);
  for (const name of ["omnibox.onInputStarted", "omnibox.onInputChanged", "omnibox.onInputEntered"]) {
    const ev = await events(name);
    push(`${name}#typed`, ev.length > 0, ev.length ? JSON.stringify(ev.at(-1)).slice(0, 160) : "not fired");
  }

  log("  action.onClicked");
  await d.evalIn(SW, "chrome.action.setPopup({ popup: '' })");
  await tb.key("g", { mods: { alt: true, shift: true } });
  const clicked = await waitFor(async () => (await events("action.onClicked"))[0], 4000);
  push("action.onClicked#shortcut", !!clicked, clicked ? `tab keys=${Object.keys(clicked[0] ?? {}).length}` : "not fired");
  await d.evalIn(SW, "chrome.action.setPopup({ popup: 'popup.html' })");

  log("  context menu");
  await tb.control("activate-tab", { url: `${site}/page.html` }).catch(() => {});
  await sleep(600);
  await tb.click(tb.width * 0.15, tb.height * 0.45, "right");
  await sleep(800);
  const shot = await tb.shot("context-menu");
  results.push({ id: "contextMenus.menu-shown", ctx: "interactive", ok: true, sig: "screenshot", note: shot });
  await tb.key("escape");
  return results;
}
