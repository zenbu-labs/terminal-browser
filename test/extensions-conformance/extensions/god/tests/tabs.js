// tabs, windows, webNavigation, scripting, sessions, tabGroups
(() => {
  const { test } = god;
  const TAB_SHAPE = { id: "number", index: "number", windowId: "number", active: "boolean", pinned: "boolean", highlighted: "boolean", incognito: "boolean", selected: "boolean", discarded: "boolean", autoDiscardable: "boolean", groupId: "number", mutedInfo: "object", url: "string?", title: "string?", status: "string?", frozen: "boolean?", lastAccessed: "number?" };
  const WINDOW_SHAPE = { id: "number", focused: "boolean", incognito: "boolean", alwaysOnTop: "boolean", type: "string", state: "string", top: "number?", left: "number?", width: "number?", height: "number?" };

  async function openTab(t, url, props = {}) {
    const tab = await chrome.tabs.create({ url, active: false, ...props });
    await waitComplete(tab.id);
    return chrome.tabs.get(tab.id);
  }

  function waitComplete(tabId, timeout = 8000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error(`tab ${tabId} never completed`));
      }, timeout);
      function listener(id, info, tab) {
        if (id === tabId && info.status === "complete") done(tab);
      }
      function done(tab) {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }
      chrome.tabs.onUpdated.addListener(listener);
      chrome.tabs.get(tabId).then((tab) => tab.status === "complete" && done(tab), () => {});
    });
  }
  god.openTab = openTab;
  god.waitComplete = waitComplete;

  const S = {};
  god.state = S;

  test("tabs.constants", () => [chrome.tabs.TAB_ID_NONE, chrome.tabs.TAB_INDEX_NONE, chrome.tabs.MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND, chrome.tabs.SPLIT_VIEW_ID_NONE].join(","));

  test("tabs.create+onCreated", async (t, c) => {
    const [created] = await t.event(chrome.tabs.onCreated, async () => {
      S.tab = await chrome.tabs.create({ url: `${c.site}/page.html?t=create`, active: false });
    }, { filter: (tab) => !S.tab || tab.id === S.tab.id });
    t.shape(created, TAB_SHAPE, "onCreated tab");
    t.shape(S.tab, TAB_SHAPE, "create result");
    t.eq(S.tab.active, false);
    await waitComplete(S.tab.id);
    return `${t.keys(created)} | pending=${"pendingUrl" in S.tab}`;
  });

  test("tabs.get", async (t, c) => {
    const tab = await chrome.tabs.get(S.tab.id);
    t.shape(tab, TAB_SHAPE);
    t.eq(tab.url, `${c.site}/page.html?t=create`);
    t.eq(tab.title, "God test page");
    t.eq(tab.status, "complete");
    return t.keys(tab);
  });

  test("tabs.get#missing", (t) => t.rejects(chrome.tabs.get(999999)));

  test("tabs.getCurrent#sw", async (t) => {
    t.eq(await chrome.tabs.getCurrent(), undefined);
  });

  test("tabs.getCurrent#page", async (t) => {
    const tab = await chrome.tabs.getCurrent();
    t.ok(tab && tab.url.endsWith("/page.html"), `got ${tab?.url}`);
  }, { ctx: ["page"] });

  test("tabs.getCurrent#popup", async (t) => {
    t.eq(await chrome.tabs.getCurrent(), undefined);
  }, { ctx: ["popup"] });

  test("tabs.query#all", async (t) => {
    const tabs = await chrome.tabs.query({});
    t.ok(tabs.some((x) => x.id === S.tab.id), "created tab missing");
    tabs.forEach((x) => t.shape(x, TAB_SHAPE));
    return "shape ok";
  });

  test("tabs.query#filters", async (t, c) => {
    const byUrl = await chrome.tabs.query({ url: `${c.site.replace(/:\d+$/, "")}/*` });
    const byUrlExact = await chrome.tabs.query({ url: `${c.site}/page.html?t=create` });
    const byTitle = await chrome.tabs.query({ title: "God test*" });
    const active = await chrome.tabs.query({ active: true, currentWindow: true });
    const lastFocused = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const status = await chrome.tabs.query({ status: "complete", windowType: "normal" });
    t.ok(byUrlExact.some((x) => x.id === S.tab.id), "url exact");
    t.ok(byTitle.some((x) => x.id === S.tab.id), "title glob");
    t.eq(active.length, 1, "active+currentWindow");
    t.eq(lastFocused.length, 1, "active+lastFocusedWindow");
    return `byUrl>0=${byUrl.length > 0} status>0=${status.length > 0}`;
  });

  test("tabs.update#url+onUpdated", async (t, c) => {
    const [, info] = await t.event(chrome.tabs.onUpdated, () => chrome.tabs.update(S.tab.id, { url: `${c.site}/page.html?t=updated` }), {
      filter: (id, info) => id === S.tab.id && info.url,
    });
    t.eq(info.url, `${c.site}/page.html?t=updated`);
    await waitComplete(S.tab.id);
    return t.keys(info);
  });

  test("tabs.onUpdated#status-sequence", async (t, c) => {
    const seen = [];
    const listener = (id, info) => id === S.tab.id && seen.push(Object.keys(info).sort().join("+") + (info.status ? `:${info.status}` : ""));
    chrome.tabs.onUpdated.addListener(listener);
    await chrome.tabs.update(S.tab.id, { url: `${c.site}/page.html?t=seq` });
    await waitComplete(S.tab.id);
    await t.sleep(300);
    chrome.tabs.onUpdated.removeListener(listener);
    t.ok(seen.some((s) => s.endsWith(":loading")), "no loading");
    t.ok(seen.some((s) => s.endsWith(":complete")), "no complete");
    return [...new Set(seen)].join(" ");
  });

  test("tabs.update#pinned", async (t) => {
    const [, info, tab] = await t.event(chrome.tabs.onUpdated, () => chrome.tabs.update(S.tab.id, { pinned: true }), { filter: (id, info) => id === S.tab.id && "pinned" in info });
    t.eq(info.pinned, true);
    t.eq(tab.pinned, true);
    await chrome.tabs.update(S.tab.id, { pinned: false });
  });

  test("tabs.update#muted", async (t) => {
    const [, info] = await t.event(chrome.tabs.onUpdated, () => chrome.tabs.update(S.tab.id, { muted: true }), { filter: (id, info) => id === S.tab.id && info.mutedInfo });
    t.shape(info.mutedInfo, { muted: "boolean", reason: "string?", extensionId: "string?" });
    t.eq(info.mutedInfo.muted, true);
    t.eq(info.mutedInfo.reason, "extension");
    await chrome.tabs.update(S.tab.id, { muted: false });
    return t.keys(info.mutedInfo);
  });

  test("tabs.update#autoDiscardable", async (t) => {
    const tab = await chrome.tabs.update(S.tab.id, { autoDiscardable: false });
    t.eq(tab.autoDiscardable, false);
    await chrome.tabs.update(S.tab.id, { autoDiscardable: true });
  });

  test("tabs.update#active+onActivated", async (t) => {
    const tab = await chrome.tabs.get(S.tab.id);
    S.previousActive = (await chrome.tabs.query({ windowId: tab.windowId })).find((x) => x.id !== S.tab.id);
    await chrome.tabs.update(S.previousActive.id, { active: true });
    await t.sleep(300);
    const [info] = await t.event(chrome.tabs.onActivated, () => chrome.tabs.update(S.tab.id, { active: true }), { filter: (i) => i.tabId === S.tab.id });
    t.shape(info, { tabId: "number", windowId: "number" });
    return t.keys(info);
  });

  test("tabs.onHighlighted", async (t) => {
    const [info] = await t.event(chrome.tabs.onHighlighted, () => chrome.tabs.update(S.previousActive.id, { active: true }), { filter: (i) => i.tabIds.includes(S.previousActive.id) });
    t.shape(info, { tabIds: "array", windowId: "number" });
    t.ok(info.tabIds.includes(S.previousActive.id), "tabIds");
    return t.keys(info);
  });

  test("tabs.highlight", async (t) => {
    const tab = await chrome.tabs.get(S.tab.id);
    const win = await chrome.tabs.highlight({ windowId: tab.windowId, tabs: [tab.index] });
    t.shape(win, WINDOW_SHAPE);
    t.eq((await chrome.tabs.get(S.tab.id)).highlighted, true);
    await chrome.tabs.update(S.previousActive.id, { active: true });
  });

  test("tabs.move+onMoved", async (t) => {
    const before = await chrome.tabs.get(S.tab.id);
    if (before.index === 0) await chrome.tabs.move(S.tab.id, { index: -1 });
    const moved = await chrome.tabs.get(S.tab.id);
    t.ok(moved.index > 0, `only tab in its window (index ${moved.index}, window ${moved.windowId})`);
    const [id, info] = await t.event(chrome.tabs.onMoved, () => chrome.tabs.move(S.tab.id, { index: 0 }), { filter: (id) => id === S.tab.id });
    t.shape(info, { windowId: "number", fromIndex: "number", toIndex: "number" });
    t.eq(info.fromIndex, moved.index);
    t.eq(info.toIndex, 0);
    t.eq((await chrome.tabs.get(S.tab.id)).index, 0);
    await chrome.tabs.move(S.tab.id, { index: -1 });
    return t.keys(info);
  });

  test("tabs.move#returns", async (t) => {
    const moved = await chrome.tabs.move(S.tab.id, { index: 0 });
    t.shape(moved, TAB_SHAPE);
    await chrome.tabs.move(S.tab.id, { index: -1 });
  });

  test("tabs.duplicate", async (t, c) => {
    const dup = await chrome.tabs.duplicate(S.tab.id);
    t.shape(dup, TAB_SHAPE);
    await waitComplete(dup.id);
    const tab = await chrome.tabs.get(dup.id);
    t.eq(tab.url, `${c.site}/page.html?t=seq`);
    await chrome.tabs.remove(dup.id);
    return `index=${dup.index === (await chrome.tabs.get(S.tab.id)).index + 1 ? "next" : "other"}`;
  });

  test("tabs.reload", async (t) => {
    const [, info] = await t.event(chrome.tabs.onUpdated, () => chrome.tabs.reload(S.tab.id, { bypassCache: true }), { filter: (id, info) => id === S.tab.id && info.status === "loading" });
    await waitComplete(S.tab.id);
    return "reloaded";
  });

  test("tabs.goBack/goForward", async (t, c) => {
    await chrome.tabs.update(S.tab.id, { url: `${c.site}/page.html?t=history-a` });
    await waitComplete(S.tab.id);
    await t.sleep(300);
    await chrome.tabs.update(S.tab.id, { url: `${c.site}/page.html?t=history-b` });
    await waitComplete(S.tab.id);
    await t.sleep(300);
    const back = await t.outcome(chrome.tabs.goBack(S.tab.id));
    await t.sleep(800);
    const afterBack = new URL((await chrome.tabs.get(S.tab.id)).url).search;
    const forward = await t.outcome(chrome.tabs.goForward(S.tab.id));
    await t.sleep(800);
    const afterForward = new URL((await chrome.tabs.get(S.tab.id)).url).search;
    return `back=${back} at=${afterBack} | forward=${forward} at=${afterForward}`;
  }, { timeout: 15000 });

  test("tabs.goForward#no-entry", (t) => t.rejects(chrome.tabs.goForward(S.tab.id)));

  test("tabs.captureVisibleTab", async (t) => {
    await chrome.tabs.update(S.tab.id, { active: true });
    await t.sleep(400);
    const tab = await chrome.tabs.get(S.tab.id);
    const png = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    await t.sleep(1100);
    t.ok(png.startsWith("data:image/png;base64,"), png.slice(0, 40));
    const jpeg = await chrome.tabs.captureVisibleTab({ format: "jpeg", quality: 50 });
    await t.sleep(1100);
    t.ok(jpeg.startsWith("data:image/jpeg;base64,"), jpeg.slice(0, 40));
    const dflt = await chrome.tabs.captureVisibleTab();
    return `default=${dflt.slice(5, 15)}`;
  });

  test("tabs.detectLanguage", async (t) => {
    const lang = await chrome.tabs.detectLanguage(S.tab.id);
    t.type(lang, "string");
    return lang;
  });

  test("tabs.getZoom", async (t) => {
    t.eq(await chrome.tabs.getZoom(S.tab.id), 1);
  });

  test("tabs.setZoom+onZoomChange", async (t) => {
    const [info] = await t.event(chrome.tabs.onZoomChange, () => chrome.tabs.setZoom(S.tab.id, 1.5), { filter: (i) => i.tabId === S.tab.id });
    t.shape(info, { tabId: "number", oldZoomFactor: "number", newZoomFactor: "number", zoomSettings: "object" });
    t.eq(info.newZoomFactor, 1.5);
    t.eq(await chrome.tabs.getZoom(S.tab.id), 1.5);
    await chrome.tabs.setZoom(S.tab.id, 0);
    t.eq(await chrome.tabs.getZoom(S.tab.id), 1, "zoom 0 resets to default");
    return `${t.keys(info)} settings=${t.keys(info.zoomSettings)}`;
  });

  test("tabs.setZoom#out-of-range", async (t) => {
    const r = await t.outcome(chrome.tabs.setZoom(S.tab.id, 10));
    await chrome.tabs.setZoom(S.tab.id, 0);
    return r;
  });

  test("tabs.getZoomSettings", async (t) => {
    const z = await chrome.tabs.getZoomSettings(S.tab.id);
    t.shape(z, { mode: "string", scope: "string", defaultZoomFactor: "number?" });
    return godJson(z);
  });

  test("tabs.setZoomSettings", async (t) => {
    await chrome.tabs.setZoomSettings(S.tab.id, { scope: "per-tab" });
    const z = await chrome.tabs.getZoomSettings(S.tab.id);
    t.eq(z.scope, "per-tab");
    await chrome.tabs.setZoomSettings(S.tab.id, { scope: "per-origin" });
  });

  test("tabs.sendMessage", async (t) => {
    const reply = await chrome.tabs.sendMessage(S.tab.id, { kind: "cs-echo", value: 7 });
    t.eq(reply?.echo, 7);
    t.eq(reply.where, "cs");
    return `frameId=${reply.frameId}`;
  });

  test("tabs.sendMessage#frameId", async (t) => {
    const reply = await chrome.tabs.sendMessage(S.tab.id, { kind: "cs-echo", value: 8 }, { frameId: 0 });
    t.eq(reply?.echo, 8);
  });

  test("tabs.sendMessage#documentId", async (t) => {
    const frame = await chrome.webNavigation.getFrame({ tabId: S.tab.id, frameId: 0 });
    const reply = await chrome.tabs.sendMessage(S.tab.id, { kind: "cs-echo", value: 9 }, { documentId: frame.documentId });
    t.eq(reply?.echo, 9);
  });

  test("tabs.sendMessage#no-receiver", (t) => t.rejects(chrome.tabs.sendMessage(S.tab.id, { kind: "nobody" }, { frameId: 12345 })));

  test("tabs.connect", async (t) => {
    const port = chrome.tabs.connect(S.tab.id, { name: "tab-port" });
    const reply = await new Promise((resolve, reject) => {
      port.onMessage.addListener(resolve);
      port.onDisconnect.addListener(() => reject(new Error(`disconnected ${chrome.runtime.lastError?.message}`)));
      port.postMessage({ ping: "tab" });
      setTimeout(() => reject(new Error("no reply")), 5000);
    });
    t.eq(reply.pong, "tab");
    port.disconnect();
    return `sender=${reply.senderKeys}`;
  });

  test("tabs.discard", async (t, c) => {
    const tab = await openTab(t, `${c.site}/page.html?t=discard`);
    const discarded = await chrome.tabs.discard(tab.id);
    t.ok(discarded, "discard returned nothing");
    t.eq(discarded.discarded, true);
    S.discardedOld = tab.id;
    S.discardedNew = discarded.id;
    await chrome.tabs.remove(discarded.id);
    return `sameId=${discarded.id === tab.id}`;
  });

  test("tabs.discard#active", async (t) => {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    const r = await chrome.tabs.discard(active.id).then((x) => (x ? `discarded=${x.discarded}` : "undefined"), (e) => `rejects: ${e.message}`);
    return r;
  });

  test("tabs.group", async (t) => {
    S.groupId = await chrome.tabs.group({ tabIds: [S.tab.id] });
    t.type(S.groupId, "number");
    t.ok(S.groupId >= 0, `groupId ${S.groupId}`);
    t.eq((await chrome.tabs.get(S.tab.id)).groupId, S.groupId);
  });

  test("tabGroups.TAB_GROUP_ID_NONE", (t) => `${chrome.tabGroups.TAB_GROUP_ID_NONE}`);

  test("tabGroups.get", async (t) => {
    const g = await chrome.tabGroups.get(S.groupId);
    t.shape(g, { id: "number", collapsed: "boolean", color: "string", title: "string?", windowId: "number" });
    return t.keys(g);
  });

  test("tabGroups.query", async (t) => {
    const groups = await chrome.tabGroups.query({});
    t.ok(groups.some((g) => g.id === S.groupId), "group missing");
  });

  test("tabGroups.update+onUpdated", async (t) => {
    const [g] = await t.event(chrome.tabGroups.onUpdated, () => chrome.tabGroups.update(S.groupId, { title: "God", color: "red" }));
    t.eq(g.title, "God");
    t.eq(g.color, "red");
  });

  test("tabGroups.move+onMoved", async (t) => {
    const [g] = await t.event(chrome.tabGroups.onMoved, () => chrome.tabGroups.move(S.groupId, { index: 0 }));
    t.eq(g.id, S.groupId);
  });

  test("tabs.ungroup+tabGroups.onRemoved", async (t) => {
    const [g] = await t.event(chrome.tabGroups.onRemoved, () => chrome.tabs.ungroup([S.tab.id]));
    t.eq(g.id, S.groupId);
    t.eq((await chrome.tabs.get(S.tab.id)).groupId, -1);
  });

  test("tabGroups.onCreated", async (t) => {
    const [g] = await t.event(chrome.tabGroups.onCreated, async () => {
      S.groupId = await chrome.tabs.group({ tabIds: [S.tab.id] });
    });
    t.type(g.id, "number");
    await chrome.tabs.ungroup([S.tab.id]);
  });

  test("tabs.createSplit", async (t) => {
    if (!chrome.tabs.createSplit) return "absent";
    return t.outcome(async () => chrome.tabs.createSplit([S.tab.id]));
  });

  test("tabs.unsplit", async (t) => {
    if (!chrome.tabs.unsplit) return "absent";
    return t.outcome(async () => chrome.tabs.unsplit(12345));
  });

  test("windows.constants", () => `${chrome.windows.WINDOW_ID_NONE},${chrome.windows.WINDOW_ID_CURRENT}`);

  test("windows.getCurrent", async (t) => {
    const w = await chrome.windows.getCurrent({ populate: true });
    t.shape(w, { ...WINDOW_SHAPE, tabs: "array" });
    t.shape(w.tabs[0], TAB_SHAPE);
    S.window = w;
    return t.keys(w);
  });

  test("windows.get", async (t) => {
    const w = await chrome.windows.get(S.window.id);
    t.eq(w.id, S.window.id);
    t.eq(w.tabs, undefined, "tabs without populate");
    return t.keys(w);
  });

  test("windows.get#missing", (t) => t.rejects(chrome.windows.get(999999)));

  test("windows.getAll", async (t) => {
    const all = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
    t.ok(all.length >= 1, "no windows");
    t.ok(all.every((w) => w.type === "normal" && Array.isArray(w.tabs)), "filter/populate");
    return `count>=1`;
  });

  test("windows.getLastFocused", async (t) => {
    const w = await chrome.windows.getLastFocused();
    t.shape(w, WINDOW_SHAPE);
  });

  test("windows.create+onCreated", async (t, c) => {
    const [created] = await t.event(chrome.windows.onCreated, async () => {
      S.newWindow = await chrome.windows.create({ url: `${c.site}/page.html?w=1`, focused: false, type: "normal" });
    });
    t.shape(created, WINDOW_SHAPE);
    t.shape(S.newWindow, { ...WINDOW_SHAPE, tabs: "array" });
    t.eq(S.newWindow.tabs.length, 1);
    t.eq(S.newWindow.type, "normal");
    return `create keys=${t.keys(S.newWindow)}`;
  });

  test("windows.update#focused+onFocusChanged", async (t) => {
    const [id] = await t.event(chrome.windows.onFocusChanged, () => chrome.windows.update(S.newWindow.id, { focused: true }), { filter: (id) => id === S.newWindow.id });
    t.eq(id, S.newWindow.id);
  });

  test("windows.update#bounds+onBoundsChanged", async (t) => {
    const [w] = await t.event(chrome.windows.onBoundsChanged, () => chrome.windows.update(S.newWindow.id, { width: 700, height: 500, left: 10, top: 10 }), { filter: (w) => w.id === S.newWindow.id });
    t.eq(w.width, 700);
    return `${w.width}x${w.height}`;
  });

  test("windows.update#state", async (t) => {
    const w = await chrome.windows.update(S.newWindow.id, { state: "minimized" });
    t.eq(w.state, "minimized");
    await chrome.windows.update(S.newWindow.id, { state: "normal" });
  });

  test("tabs.onDetached+onAttached", async (t) => {
    const tab = await openTab(t, "about:blank");
    const detached = t.event(chrome.tabs.onDetached, null, { filter: (id) => id === tab.id });
    const [id, info] = await t.event(chrome.tabs.onAttached, () => chrome.tabs.move(tab.id, { windowId: S.newWindow.id, index: -1 }), { filter: (id) => id === tab.id });
    const [, dinfo] = await detached;
    t.shape(info, { newWindowId: "number", newPosition: "number" });
    t.shape(dinfo, { oldWindowId: "number", oldPosition: "number" });
    t.eq(info.newWindowId, S.newWindow.id);
    await chrome.tabs.remove(tab.id);
  });

  test("windows.remove+onRemoved", async (t) => {
    const [id] = await t.event(chrome.windows.onRemoved, () => chrome.windows.remove(S.newWindow.id), { filter: (id) => id === S.newWindow.id });
    t.eq(id, S.newWindow.id);
  });

  test("tabs.onRemoved#window-closing", async (t, c) => {
    const w = await chrome.windows.create({ url: "about:blank", focused: false });
    const [id, info] = await t.event(chrome.tabs.onRemoved, () => chrome.windows.remove(w.id), { filter: (id) => id === w.tabs[0].id });
    t.eq(info.isWindowClosing, true);
    t.eq(info.windowId, w.id);
  });

  test("windows.create#popup", async (t, c) => {
    const w = await chrome.windows.create({ url: `${c.site}/page.html?popup=1`, type: "popup", width: 400, height: 300, focused: false });
    t.eq(w.type, "popup");
    const all = await chrome.windows.getAll({ windowTypes: ["popup"] });
    t.ok(all.some((x) => x.id === w.id), "popup not listed");
    await chrome.windows.remove(w.id);
  });

  test("windows.create#tabId", async (t, c) => {
    const tab = await openTab(t, "about:blank");
    const w = await chrome.windows.create({ tabId: tab.id, focused: false });
    t.eq(w.tabs[0].id, tab.id);
    await chrome.windows.remove(w.id);
  });

  test("windows.create#extension-page", async (t, c) => {
    const w = await chrome.windows.create({ url: "page.html?win=1", type: "popup", focused: false });
    try {
      t.ok(w.tabs[0].url?.includes("page.html") || w.tabs[0].pendingUrl?.includes("page.html"), `tab url/pendingUrl missing: ${t.keys(w.tabs[0])}`);
    } finally {
      await chrome.windows.remove(w.id);
    }
  });

  test("tabs.remove+onRemoved", async (t, c) => {
    const tab = await openTab(t, `${c.site}/page.html?t=remove`);
    S.closedUrl = tab.url;
    const [id, info] = await t.event(chrome.tabs.onRemoved, () => chrome.tabs.remove(tab.id), { filter: (id) => id === tab.id });
    t.shape(info, { windowId: "number", isWindowClosing: "boolean" });
    t.eq(info.isWindowClosing, false);
    return t.keys(info);
  });

  test("tabs.remove#array", async (t) => {
    const a = await chrome.tabs.create({ url: "about:blank", active: false });
    const b = await chrome.tabs.create({ url: "about:blank", active: false });
    await chrome.tabs.remove([a.id, b.id]);
    await t.rejects(chrome.tabs.get(a.id));
  });

  test("tabs.create#extension-relative-url", async (t) => {
    const tab = await chrome.tabs.create({ url: "page.html?rel=1", active: false });
    await waitComplete(tab.id);
    const got = await chrome.tabs.get(tab.id);
    t.eq(got.url, chrome.runtime.getURL("page.html?rel=1"));
    await chrome.tabs.remove(tab.id);
  });

  test("tabs.create#chrome-url", async (t) => {
    const tab = await chrome.tabs.create({ url: "chrome://version", active: false });
    await t.sleep(800);
    const got = await chrome.tabs.get(tab.id);
    await chrome.tabs.remove(tab.id);
    return `url=${(got.url || got.pendingUrl).replace(/^[a-z-]+:\/\//, "SCHEME://")}`;
  });

  test("tabs.create#javascript-url", (t) => t.rejects(chrome.tabs.create({ url: "javascript:alert(1)" })));

  test("tabs.create#opener", async (t, c) => {
    const tab = await chrome.tabs.create({ url: "about:blank", active: false, openerTabId: S.tab.id, windowId: (await chrome.tabs.get(S.tab.id)).windowId });
    t.eq(tab.openerTabId, S.tab.id);
    await chrome.tabs.remove(tab.id);
  });

  test("sessions.MAX_SESSION_RESULTS", () => `${chrome.sessions.MAX_SESSION_RESULTS}`);

  test("sessions.getRecentlyClosed", async (t, c) => {
    const list = await chrome.sessions.getRecentlyClosed({ maxResults: 5 });
    t.type(list, "array");
    t.ok(list.length > 0, "nothing recently closed");
    t.shape(list[0], { lastModified: "number", tab: "object?", window: "object?" });
    const hit = list.find((s) => s.tab?.url === S.closedUrl);
    t.ok(hit, `closed tab ${S.closedUrl} not listed; got ${list.map((s) => s.tab?.url ?? "window").join(" ")}`);
    t.type(hit.tab.sessionId, "string");
    S.sessionId = hit.tab.sessionId;
    return `tab keys=${t.keys(hit.tab)}`;
  });

  test("sessions.restore", async (t) => {
    const restored = await chrome.sessions.restore(S.sessionId);
    t.ok(restored.tab, "no tab");
    await waitComplete(restored.tab.id).catch(() => {});
    t.eq(restored.tab.url, S.closedUrl);
    await chrome.tabs.remove(restored.tab.id);
  });

  test("sessions.restore#bad-id", (t) => t.rejects(chrome.sessions.restore("nope")));

  test("sessions.onChanged", async (t) => {
    const tab = await chrome.tabs.create({ url: "about:blank", active: false });
    await t.sleep(300);
    await t.event(chrome.sessions.onChanged, () => chrome.tabs.remove(tab.id));
  });

  test("sessions.getDevices", async (t) => {
    const d = await chrome.sessions.getDevices();
    t.eq(d, []);
  });

  test("webNavigation.events#sequence", async (t, c) => {
    const order = [];
    const details = {};
    const names = ["onBeforeNavigate", "onCommitted", "onDOMContentLoaded", "onCompleted"];
    const listeners = names.map((name) => {
      const fn = (d) => {
        if (d.tabId !== S.tab.id || d.frameId !== 0) return;
        order.push(name);
        details[name] = d;
      };
      chrome.webNavigation[name].addListener(fn);
      return [name, fn];
    });
    await chrome.tabs.update(S.tab.id, { url: `${c.site}/page.html?nav=1` });
    await waitComplete(S.tab.id);
    await t.sleep(500);
    listeners.forEach(([name, fn]) => chrome.webNavigation[name].removeListener(fn));
    t.eq(order.filter((n, i) => order.indexOf(n) === i), names);
    const b = details.onBeforeNavigate, cm = details.onCommitted, done = details.onCompleted;
    t.shape(b, { tabId: "number", url: "string", frameId: "number", parentFrameId: "number", timeStamp: "number", processId: "number?", frameType: "string", documentLifecycle: "string?", parentDocumentId: "string?" });
    t.shape(cm, { transitionType: "string", transitionQualifiers: "array", documentId: "string", documentLifecycle: "string", frameType: "string", processId: "number" });
    t.eq(b.parentFrameId, -1);
    S.documentId = cm.documentId;
    return `before=${t.keys(b)} | committed=${t.keys(cm)} transition=${cm.transitionType} | completed=${t.keys(done)}`;
  });

  test("webNavigation.onErrorOccurred", async (t) => {
    const [d] = await t.event(chrome.webNavigation.onErrorOccurred, () => chrome.tabs.update(S.tab.id, { url: "http://localhost:1/unreachable" }), { filter: (d) => d.tabId === S.tab.id && d.frameId === 0 });
    t.shape(d, { error: "string", url: "string", timeStamp: "number" });
    return d.error;
  });

  test("webNavigation.onHistoryStateUpdated", async (t, c) => {
    const [d] = await t.event(chrome.webNavigation.onHistoryStateUpdated, () => chrome.tabs.update(S.tab.id, { url: `${c.site}/history-push.html` }), { filter: (d) => d.tabId === S.tab.id, timeout: 8000 });
    t.ok(d.url.endsWith("/history-pushed"), d.url);
    return `transition=${d.transitionType}`;
  });

  test("webNavigation.onReferenceFragmentUpdated", async (t, c) => {
    const [d] = await t.event(chrome.webNavigation.onReferenceFragmentUpdated, () => chrome.tabs.update(S.tab.id, { url: `${c.site}/history-push.html` }), { filter: (d) => d.tabId === S.tab.id, timeout: 8000 });
    t.ok(d.url.endsWith("#frag"), d.url);
  });

  test("webNavigation.filters", async (t, c) => {
    const seen = [];
    const fn = (d) => d.tabId === S.tab.id && seen.push(new URL(d.url).search);
    chrome.webNavigation.onCompleted.addListener(fn, { url: [{ queryContains: "match=yes" }] });
    await chrome.tabs.update(S.tab.id, { url: `${c.site}/page.html?match=no` });
    await waitComplete(S.tab.id);
    await chrome.tabs.update(S.tab.id, { url: `${c.site}/page.html?match=yes` });
    await waitComplete(S.tab.id);
    await t.sleep(400);
    chrome.webNavigation.onCompleted.removeListener(fn);
    t.eq(seen, ["?match=yes"]);
  });

  test("webNavigation.getFrame", async (t, c) => {
    const f = await chrome.webNavigation.getFrame({ tabId: S.tab.id, frameId: 0 });
    t.shape(f, { url: "string", parentFrameId: "number", errorOccurred: "boolean", documentId: "string", documentLifecycle: "string", frameType: "string", parentDocumentId: "string?" });
    t.eq(f.url, `${c.site}/page.html?match=yes`);
    const byDoc = await chrome.webNavigation.getFrame({ documentId: f.documentId });
    t.eq(byDoc.url, f.url);
    return t.keys(f);
  });

  test("webNavigation.getAllFrames", async (t, c) => {
    await chrome.tabs.update(S.tab.id, { url: `${c.site}/frames.html` });
    await waitComplete(S.tab.id);
    await t.sleep(500);
    const frames = await chrome.webNavigation.getAllFrames({ tabId: S.tab.id });
    t.eq(frames.length, 2);
    t.shape(frames[1], { frameId: "number", processId: "number", url: "string", parentFrameId: "number", documentId: "string", frameType: "string" });
    S.childFrameId = frames.find((f) => f.parentFrameId === 0)?.frameId;
    return t.keys(frames[0]);
  });

  test("webNavigation.getFrame#missing", async (t) => {
    const f = await chrome.webNavigation.getFrame({ tabId: S.tab.id, frameId: 99999 }).catch((e) => `rejects: ${e.message}`);
    return f === null ? "null" : String(f);
  });

  test("webNavigation.onCreatedNavigationTarget", async (t) => t.ok(chrome.webNavigation.onCreatedNavigationTarget.addListener, "missing"));
  test("webNavigation.onTabReplaced", async (t) => t.ok(chrome.webNavigation.onTabReplaced.addListener, "missing"));

  test("scripting.executeScript#func", async (t) => {
    const res = await chrome.scripting.executeScript({ target: { tabId: S.tab.id }, func: (a, b) => `${document.title}|${a + b}`, args: [2, 3] });
    t.eq(res.length, 1);
    t.shape(res[0], { frameId: "number", result: "string", documentId: "string" });
    t.eq(res[0].result, "frames|5");
    return t.keys(res[0]);
  });

  test("scripting.executeScript#allFrames", async (t) => {
    const res = await chrome.scripting.executeScript({ target: { tabId: S.tab.id, allFrames: true }, func: () => location.pathname });
    return res.map((r) => r.result).sort().join(",");
  });

  test("scripting.executeScript#frameIds", async (t) => {
    const res = await chrome.scripting.executeScript({ target: { tabId: S.tab.id, frameIds: [S.childFrameId] }, func: () => location.search });
    t.eq(res[0].result, "?frame=1");
  });

  test("scripting.executeScript#files", async (t) => {
    const res = await chrome.scripting.executeScript({ target: { tabId: S.tab.id }, files: ["inject.js"] });
    t.eq(res[0].result, "injected-file");
  });

  test("scripting.executeScript#world-main", async (t, c) => {
    await chrome.tabs.update(S.tab.id, { url: `${c.site}/page.html?t=world` });
    await waitComplete(S.tab.id);
    const main = await chrome.scripting.executeScript({ target: { tabId: S.tab.id }, world: "MAIN", func: () => typeof window.godMainMarker });
    const isolated = await chrome.scripting.executeScript({ target: { tabId: S.tab.id }, func: () => typeof window.godMainMarker });
    t.eq(main[0].result, "string", "MAIN world");
    t.eq(isolated[0].result, "undefined", "ISOLATED world");
  });

  test("scripting.executeScript#promise-result", async (t) => {
    const res = await chrome.scripting.executeScript({ target: { tabId: S.tab.id }, func: () => new Promise((r) => setTimeout(() => r("awaited"), 50)) });
    t.eq(res[0].result, "awaited");
  });

  test("scripting.executeScript#error", async (t) => {
    const res = await chrome.scripting.executeScript({ target: { tabId: S.tab.id }, func: () => { throw new Error("boom"); } }).catch((e) => `rejects: ${e.message}`);
    return typeof res === "string" ? res : `result=${godJson(res[0].result)} error=${godJson(res[0].error ?? null)}`;
  });

  test("scripting.executeScript#chrome-url", (t) => t.rejects(async () => {
    const tab = await chrome.tabs.create({ url: "chrome://version", active: false });
    await t.sleep(600);
    try {
      return await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => 1 });
    } finally {
      chrome.tabs.remove(tab.id);
    }
  }));

  test("scripting.executeScript#injectImmediately", async (t) => {
    const res = await chrome.scripting.executeScript({ target: { tabId: S.tab.id }, injectImmediately: true, func: () => 1 });
    t.eq(res[0].result, 1);
  });

  test("scripting.insertCSS/removeCSS", async (t) => {
    const css = "body { outline: 7px solid rgb(1, 2, 3) !important; }";
    const read = async () => (await chrome.scripting.executeScript({ target: { tabId: S.tab.id }, func: () => getComputedStyle(document.body).outlineWidth }))[0].result;
    const before = await read();
    await chrome.scripting.insertCSS({ target: { tabId: S.tab.id }, css });
    t.eq(await read(), "7px", "after insert");
    await chrome.scripting.removeCSS({ target: { tabId: S.tab.id }, css });
    t.eq(await read(), before, "after remove");
    await chrome.scripting.insertCSS({ target: { tabId: S.tab.id }, files: ["inject.css"], origin: "USER" });
  });

  test("scripting.registerContentScripts", async (t, c) => {
    await chrome.scripting.registerContentScripts([{ id: "god-dyn", matches: ["http://localhost/*"], js: ["dyn-cs.js"], runAt: "document_start", persistAcrossSessions: false }]);
    await chrome.tabs.update(S.tab.id, { url: `${c.site}/page.html?t=dyn` });
    await waitComplete(S.tab.id);
    const res = await chrome.scripting.executeScript({ target: { tabId: S.tab.id }, func: () => document.documentElement.dataset.godDyn });
    t.eq(res[0].result, "yes");
  });

  test("scripting.registerContentScripts#duplicate", (t) => t.rejects(chrome.scripting.registerContentScripts([{ id: "god-dyn", matches: ["http://localhost/*"], js: ["dyn-cs.js"] }])));

  test("scripting.getRegisteredContentScripts", async (t) => {
    const list = await chrome.scripting.getRegisteredContentScripts();
    const s = list.find((x) => x.id === "god-dyn");
    t.ok(s, "missing");
    t.eq(s.persistAcrossSessions, false);
    const filtered = await chrome.scripting.getRegisteredContentScripts({ ids: ["god-dyn"] });
    t.eq(filtered.length, 1);
    return t.keys(s);
  });

  test("scripting.updateContentScripts", async (t) => {
    await chrome.scripting.updateContentScripts([{ id: "god-dyn", excludeMatches: ["http://localhost/excluded*"] }]);
    const [s] = await chrome.scripting.getRegisteredContentScripts({ ids: ["god-dyn"] });
    t.eq(s.excludeMatches, ["http://localhost/excluded*"]);
  });

  test("scripting.unregisterContentScripts", async (t) => {
    await chrome.scripting.unregisterContentScripts({ ids: ["god-dyn"] });
    t.eq(await chrome.scripting.getRegisteredContentScripts({ ids: ["god-dyn"] }), []);
    return t.rejects(chrome.scripting.unregisterContentScripts({ ids: ["god-dyn"] }));
  });

  test("scripting.ExecutionWorld", (t) => godJson(chrome.scripting.ExecutionWorld));
})();
