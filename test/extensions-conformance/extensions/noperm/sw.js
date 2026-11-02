// Permission gating: this extension only has a localhost host permission and
// two optional permissions it never gets granted.
const results = [];

async function check(id, fn) {
  try {
    const sig = await fn();
    results.push({ id, ctx: "noperm", ok: true, sig: String(sig ?? "ok"), note: "" });
  } catch (error) {
    results.push({ id, ctx: "noperm", ok: false, sig: `throws: ${error.message}`, note: String(error.message) });
  }
}

function expect(cond, message) {
  if (!cond) throw new Error(message);
}

const API_PERMISSIONS = ["alarms", "bookmarks", "browsingData", "contentSettings", "contextMenus", "cookies", "debugger", "declarativeContent", "declarativeNetRequest", "downloads", "fontSettings", "history", "identity", "idle", "notifications", "offscreen", "pageCapture", "power", "privacy", "proxy", "readingList", "scripting", "search", "sessions", "sidePanel", "storage", "system", "tabCapture", "tabGroups", "topSites", "tts", "ttsEngine", "userScripts", "webNavigation", "webRequest", "action", "commands", "omnibox", "devtools"];

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (message?.kind !== "run-gating") return;
  runGating(message.config).then(sendResponse);
  return true;
});

globalThis.runGating = async (config) => {
  results.length = 0;

  await check("gating.chrome-namespaces", () => Object.keys(chrome).sort().join(","));

  for (const ns of API_PERMISSIONS) {
    await check(`gating.${ns}-hidden`, () => {
      expect(chrome[ns] === undefined, `chrome.${ns} is exposed without its permission/manifest key`);
      return "undefined";
    });
  }

  await check("gating.optional-permission-hidden-before-grant", () => {
    expect(chrome.cookies === undefined && chrome.history === undefined, `cookies=${typeof chrome.cookies} history=${typeof chrome.history}`);
    return "hidden";
  });

  await check("gating.optional.permissions.contains", async () => `${await chrome.permissions.contains({ permissions: ["cookies"] })}`);

  await check("gating.permissions.getAll", async () => {
    const all = await chrome.permissions.getAll();
    return `${all.permissions.sort().join(",")}|${all.origins.sort().join(",")}`;
  });

  await check("gating.management.without-permission", () => Object.keys(chrome.management ?? {}).sort().join(","));
  await check("gating.management.getSelf", async () => (await chrome.management.getSelf()).name);

  await check("gating.tabs.query-scrubbed", async () => {
    const tabs = await chrome.tabs.query({});
    const local = tabs.filter((t) => t.url?.startsWith("http://localhost"));
    const hidden = tabs.filter((t) => t.url === undefined);
    expect(local.length > 0, "localhost tab url hidden despite host permission");
    expect(hidden.length > 0, "every tab url visible without tabs permission");
    expect(hidden.every((t) => t.title === undefined && t.favIconUrl === undefined && t.pendingUrl === undefined), "title/favIconUrl leaked on a non-permitted tab");
    expect(local.every((t) => typeof t.title === "string"), "title hidden on permitted host");
    return "scrubbed per host";
  });

  await check("gating.tabs.query-by-url-needs-permission", async () => {
    const r = await chrome.tabs.query({ url: "https://*/*" });
    return `count=${r.length}`;
  });

  await check("gating.windows.populate-scrubbed", async () => {
    const wins = await chrome.windows.getAll({ populate: true });
    const tabs = wins.flatMap((w) => w.tabs);
    expect(tabs.some((t) => t.url === undefined), "populated tabs not scrubbed");
    return "scrubbed";
  });

  await check("gating.tabs.onUpdated-scrubbed", async () => {
    const seen = [];
    const fn = (id, info) => seen.push(Object.keys(info).sort().join("+"));
    chrome.tabs.onUpdated.addListener(fn);
    const tab = await chrome.tabs.create({ url: "about:blank?gating", active: false });
    await new Promise((r) => setTimeout(r, 1200));
    chrome.tabs.onUpdated.removeListener(fn);
    await chrome.tabs.remove(tab.id);
    expect(!seen.some((s) => s.split("+").includes("url") || s.split("+").includes("title")), `url/title leaked: ${seen.join(" ")}`);
    return [...new Set(seen)].join(" ");
  });

  await check("gating.tabs.create-returns-scrubbed", async () => {
    const tab = await chrome.tabs.create({ url: "about:blank?created", active: false });
    await chrome.tabs.remove(tab.id);
    return `url=${tab.url === undefined ? "hidden" : "visible"} pendingUrl=${tab.pendingUrl === undefined ? "hidden" : "visible"}`;
  });

  await check("gating.tabs.captureVisibleTab-needs-permission", async () => {
    try {
      await chrome.tabs.captureVisibleTab();
      return "resolved";
    } catch (error) {
      return `rejects: ${error.message}`;
    }
  });

  await check("gating.tabs.executeScript-mv3-absent", () => `${typeof chrome.tabs.executeScript}`);

  await check("gating.tabs.sendMessage-allowed", () => `${typeof chrome.tabs.sendMessage}`);

  await check("gating.runtime.sendNativeMessage-absent", () => `${typeof chrome.runtime.sendNativeMessage}/${typeof chrome.runtime.connectNative}`);

  await check("gating.permissions.request-undeclared", async () => {
    try {
      await chrome.permissions.request({ permissions: ["bookmarks"] });
      return "resolved";
    } catch (error) {
      return `rejects: ${error.message}`;
    }
  });

  await check("gating.debugger-other-extension", async () => {
    return typeof chrome.debugger;
  });

  return results;
};
