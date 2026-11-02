// cookies, history, bookmarks, downloads, topSites, search, browsingData, readingList
(() => {
  const { test } = god;
  const S = {};
  const COOKIE_SHAPE = { name: "string", value: "string", domain: "string", hostOnly: "boolean", path: "string", secure: "boolean", httpOnly: "boolean", sameSite: "string", session: "boolean", storeId: "string", expirationDate: "number?", partitionKey: "object?" };
  const NODE_SHAPE = { id: "string", parentId: "string?", index: "number?", title: "string", url: "string?", dateAdded: "number?", dateGroupModified: "number?", syncing: "boolean?", folderType: "string?", unmodifiable: "string?" };
  const DOWNLOAD_SHAPE = { id: "number", url: "string", finalUrl: "string", referrer: "string", filename: "string", incognito: "boolean", danger: "string", mime: "string", startTime: "string", state: "string", paused: "boolean", canResume: "boolean", bytesReceived: "number", totalBytes: "number", fileSize: "number", exists: "boolean", byExtensionId: "string?", byExtensionName: "string?", endTime: "string?", estimatedEndTime: "string?", error: "string?" };

  test("cookies.set", async (t, c) => {
    const cookie = await chrome.cookies.set({ url: `${c.site}/`, name: "god1", value: "v1" });
    t.shape(cookie, COOKIE_SHAPE);
    t.eq(cookie.domain, "localhost");
    t.eq(cookie.session, true);
    t.eq(cookie.sameSite, "unspecified");
    return `${t.keys(cookie)} storeId=${cookie.storeId}`;
  });

  test("cookies.set#expiry+attrs", async (t, c) => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const cookie = await chrome.cookies.set({ url: `${c.site}/sub/`, name: "god2", value: "v2", path: "/sub", httpOnly: true, sameSite: "lax", expirationDate: exp });
    t.eq(cookie.session, false);
    t.eq(cookie.httpOnly, true);
    t.eq(cookie.sameSite, "lax");
    t.eq(Math.round(cookie.expirationDate), exp);
  });

  test("cookies.get", async (t, c) => {
    const cookie = await chrome.cookies.get({ url: `${c.site}/`, name: "god1" });
    t.eq(cookie.value, "v1");
    t.eq(await chrome.cookies.get({ url: `${c.site}/`, name: "absent" }), null);
  });

  test("cookies.getAll", async (t, c) => {
    const all = await chrome.cookies.getAll({ domain: "localhost" });
    t.ok(all.some((x) => x.name === "god1") && all.some((x) => x.name === "god2"), all.map((x) => x.name).join(","));
    const byName = await chrome.cookies.getAll({ name: "god2" });
    t.eq(byName.length, 1);
    const byUrl = await chrome.cookies.getAll({ url: `${c.site}/` });
    t.ok(!byUrl.some((x) => x.name === "god2"), "path filter ignored");
    return "filters ok";
  });

  test("cookies.onChanged", async (t, c) => {
    const [info] = await t.event(chrome.cookies.onChanged, () => chrome.cookies.set({ url: `${c.site}/`, name: "god3", value: "x" }), { filter: (i) => i.cookie.name === "god3" });
    t.shape(info, { removed: "boolean", cookie: "object", cause: "string" });
    t.eq(info.removed, false);
    t.eq(info.cause, "explicit");
    const [over] = await t.event(chrome.cookies.onChanged, () => chrome.cookies.set({ url: `${c.site}/`, name: "god3", value: "y" }), { filter: (i) => i.cookie.name === "god3" && i.removed });
    t.eq(over.cause, "overwrite");
  });

  test("cookies.onChanged#from-page", async (t, c) => {
    const [info] = await t.event(chrome.cookies.onChanged, () => fetch(`${c.site}/set-cookie`), { filter: (i) => i.cookie.name === "served" });
    t.eq(info.cookie.value, "1");
  });

  test("cookies.remove", async (t, c) => {
    const res = await chrome.cookies.remove({ url: `${c.site}/`, name: "god1" });
    t.shape(res, { url: "string", name: "string", storeId: "string" });
    t.eq(await chrome.cookies.get({ url: `${c.site}/`, name: "god1" }), null);
    return t.keys(res);
  });

  test("cookies.remove#missing", async (t, c) => {
    const res = await chrome.cookies.remove({ url: `${c.site}/`, name: "never-set" });
    return res === null ? "null" : t.keys(res);
  });

  test("cookies.getAllCookieStores", async (t) => {
    const stores = await chrome.cookies.getAllCookieStores();
    t.ok(stores.length >= 1, "none");
    t.shape(stores[0], { id: "string", tabIds: "array" });
    t.eq(stores[0].id, "0");
  });

  test("cookies.getPartitionKey", async (t) => {
    const [tab] = await chrome.tabs.query({ url: "http://localhost/*" });
    const res = await chrome.cookies.getPartitionKey({ tabId: tab.id, frameId: 0 });
    t.shape(res, { partitionKey: "object" });
    return godJson(res.partitionKey);
  });

  test("cookies.set#partitioned", async (t, c) => {
    const cookie = await chrome.cookies.set({ url: "https://partitioned.test/", name: "chip", value: "1", secure: true, sameSite: "no_restriction", partitionKey: { topLevelSite: "https://top.test" } });
    t.eq(cookie.partitionKey?.topLevelSite, "https://top.test");
    const got = await chrome.cookies.get({ url: "https://partitioned.test/", name: "chip", partitionKey: { topLevelSite: "https://top.test" } });
    t.eq(got?.value, "1");
  });

  test("cookies.set#invalid-url", (t) => t.rejects(chrome.cookies.set({ url: "not a url", name: "x", value: "y" })));

  test("history.addUrl+onVisited", async (t, c) => {
    const url = `${c.site}/history-entry-1`;
    const [item] = await t.event(chrome.history.onVisited, () => chrome.history.addUrl({ url }), { filter: (i) => i.url === url });
    t.shape(item, { id: "string", url: "string", title: "string?", lastVisitTime: "number", visitCount: "number", typedCount: "number" });
    return t.keys(item);
  });

  test("history.search", async (t, c) => {
    const items = await chrome.history.search({ text: "history-entry-1", startTime: 0, maxResults: 10 });
    t.eq(items.length, 1);
    t.eq(items[0].url, `${c.site}/history-entry-1`);
    const pages = await chrome.history.search({ text: "", startTime: 0 });
    t.ok(pages.some((i) => i.url.includes("/page.html")), "real navigations not recorded");
    return t.keys(items[0]);
  });

  test("history.getVisits", async (t, c) => {
    const visits = await chrome.history.getVisits({ url: `${c.site}/history-entry-1` });
    t.eq(visits.length, 1);
    t.shape(visits[0], { id: "string", visitId: "string", visitTime: "number", referringVisitId: "string", transition: "string", isLocal: "boolean" });
    return `${t.keys(visits[0])} transition=${visits[0].transition}`;
  });

  test("history.deleteUrl+onVisitRemoved", async (t, c) => {
    const url = `${c.site}/history-entry-1`;
    const [removed] = await t.event(chrome.history.onVisitRemoved, () => chrome.history.deleteUrl({ url }));
    t.eq(removed.allHistory, false);
    t.eq(removed.urls, [url]);
    t.eq((await chrome.history.search({ text: "history-entry-1", startTime: 0 })).length, 0);
  });

  test("history.deleteRange", async (t, c) => {
    const start = Date.now();
    await chrome.history.addUrl({ url: `${c.site}/history-range` });
    await chrome.history.deleteRange({ startTime: start - 1, endTime: Date.now() + 1 });
    t.eq((await chrome.history.search({ text: "history-range", startTime: 0 })).length, 0);
  });

  test("history.deleteAll", async (t, c) => {
    await chrome.history.addUrl({ url: `${c.site}/history-all` });
    const [removed] = await t.event(chrome.history.onVisitRemoved, () => chrome.history.deleteAll());
    t.eq(removed.allHistory, true);
    t.eq((await chrome.history.search({ text: "", startTime: 0 })).length, 0);
    return `urls=${godJson(removed.urls)}`;
  });

  test("history.addUrl#invalid", (t) => t.rejects(chrome.history.addUrl({ url: "not-a-url" })));

  test("bookmarks.constants", () => `${chrome.bookmarks.ROOT_NODE_ID},${chrome.bookmarks.MAX_WRITE_OPERATIONS_PER_HOUR},${chrome.bookmarks.MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE}`);

  test("bookmarks.getTree", async (t) => {
    const [root] = await chrome.bookmarks.getTree();
    t.eq(root.id, "0");
    t.shape(root, NODE_SHAPE);
    return root.children.map((n) => `${n.id}:${n.title}:${n.folderType ?? ""}`).join(" ");
  });

  test("bookmarks.create+onCreated", async (t, c) => {
    const [id, node] = await t.event(chrome.bookmarks.onCreated, async () => {
      S.bm = await chrome.bookmarks.create({ parentId: "2", title: "God bookmark", url: `${c.site}/bm` });
    });
    t.shape(S.bm, NODE_SHAPE);
    t.eq(id, S.bm.id);
    t.eq(node.title, "God bookmark");
    t.eq(S.bm.parentId, "2");
    return t.keys(S.bm);
  });

  test("bookmarks.create#folder", async (t) => {
    S.folder = await chrome.bookmarks.create({ parentId: "1", title: "God folder" });
    t.eq(S.folder.url, undefined);
    S.child = await chrome.bookmarks.create({ parentId: S.folder.id, title: "child", url: "https://example.com/child" });
    t.eq(S.child.index, 0);
  });

  test("bookmarks.create#default-parent", async (t) => {
    const n = await chrome.bookmarks.create({ title: "default parent", url: "https://example.com/dp" });
    const parent = n.parentId;
    await chrome.bookmarks.remove(n.id);
    return `parent=${parent}`;
  });

  test("bookmarks.get", async (t) => {
    const [n] = await chrome.bookmarks.get(S.bm.id);
    t.eq(n.title, "God bookmark");
    const many = await chrome.bookmarks.get([S.bm.id, S.folder.id]);
    t.eq(many.length, 2);
    return t.rejects(chrome.bookmarks.get("999999"));
  });

  test("bookmarks.getChildren", async (t) => {
    const kids = await chrome.bookmarks.getChildren(S.folder.id);
    t.eq(kids.map((k) => k.title), ["child"]);
  });

  test("bookmarks.getRecent", async (t) => {
    const recent = await chrome.bookmarks.getRecent(2);
    t.eq(recent.length, 2);
    t.ok(recent.every((n) => n.url), "folders in getRecent");
  });

  test("bookmarks.getSubTree", async (t) => {
    const [n] = await chrome.bookmarks.getSubTree(S.folder.id);
    t.eq(n.children.length, 1);
  });

  test("bookmarks.search", async (t, c) => {
    t.eq((await chrome.bookmarks.search("God bookmark")).length, 1);
    t.eq((await chrome.bookmarks.search({ url: `${c.site}/bm` })).length, 1);
    t.eq((await chrome.bookmarks.search({ title: "God folder" })).length, 1);
  });

  test("bookmarks.update+onChanged", async (t) => {
    const [id, info] = await t.event(chrome.bookmarks.onChanged, () => chrome.bookmarks.update(S.bm.id, { title: "Renamed" }));
    t.eq(id, S.bm.id);
    t.eq(info.title, "Renamed");
    return t.keys(info);
  });

  test("bookmarks.update#folder-url", (t) => t.rejects(chrome.bookmarks.update(S.folder.id, { url: "https://example.com" })));

  test("bookmarks.move+onMoved", async (t) => {
    const [id, info] = await t.event(chrome.bookmarks.onMoved, () => chrome.bookmarks.move(S.bm.id, { parentId: S.folder.id, index: 0 }));
    t.shape(info, { parentId: "string", index: "number", oldParentId: "string", oldIndex: "number" });
    t.eq(info.parentId, S.folder.id);
    t.eq(info.oldParentId, "2");
    t.eq((await chrome.bookmarks.getChildren(S.folder.id)).map((k) => k.title), ["Renamed", "child"]);
  });

  test("bookmarks.move#forward-index", async (t) => {
    const a = await chrome.bookmarks.create({ parentId: S.folder.id, title: "x-last", url: "https://example.com/x" });
    await chrome.bookmarks.move(S.bm.id, { parentId: S.folder.id, index: 2 });
    const titles = (await chrome.bookmarks.getChildren(S.folder.id)).map((k) => k.title);
    await chrome.bookmarks.remove(a.id);
    t.eq(titles, ["child", "Renamed", "x-last"]);
  });

  test("bookmarks.remove+onRemoved", async (t) => {
    const [id, info] = await t.event(chrome.bookmarks.onRemoved, () => chrome.bookmarks.remove(S.bm.id));
    t.shape(info, { parentId: "string", index: "number", node: "object" });
    t.eq(id, S.bm.id);
    return t.keys(info);
  });

  test("bookmarks.remove#non-empty-folder", (t) => t.rejects(chrome.bookmarks.remove(S.folder.id)));
  test("bookmarks.remove#root", (t) => t.rejects(chrome.bookmarks.remove("1")));
  test("bookmarks.create#in-root", (t) => t.rejects(chrome.bookmarks.create({ parentId: "0", title: "nope" })));

  test("bookmarks.removeTree", async (t) => {
    await chrome.bookmarks.removeTree(S.folder.id);
    await t.rejects(chrome.bookmarks.get(S.folder.id));
  });

  test("bookmarks.onChildrenReordered", (t) => t.ok(chrome.bookmarks.onChildrenReordered.addListener));
  test("bookmarks.onImportBegan/Ended", (t) => t.ok(chrome.bookmarks.onImportBegan.addListener && chrome.bookmarks.onImportEnded.addListener));

  test("downloads.download+onCreated", async (t, c) => {
    const [item] = await t.event(chrome.downloads.onCreated, async () => {
      S.dl = await chrome.downloads.download({ url: `${c.site}/download.txt`, filename: "god-dl.txt", conflictAction: "uniquify" });
    });
    t.type(S.dl, "number");
    t.shape(item, DOWNLOAD_SHAPE);
    t.eq(item.id, S.dl);
    const [found] = await chrome.downloads.search({ id: S.dl });
    return `${t.keys(item)} byExtensionId(onCreated)=${item.byExtensionId === chrome.runtime.id} byExtensionId(search)=${found.byExtensionId === chrome.runtime.id}`;
  });

  test("downloads.onChanged#complete", async (t) => {
    const done = async () => (await chrome.downloads.search({ id: S.dl }))[0]?.state === "complete";
    if (!(await done())) await t.event(chrome.downloads.onChanged, null, { filter: (d) => d.id === S.dl && d.state?.current === "complete" });
    return "complete";
  });

  test("downloads.search", async (t) => {
    const [item] = await chrome.downloads.search({ id: S.dl });
    t.shape(item, DOWNLOAD_SHAPE);
    t.eq(item.state, "complete");
    t.ok(item.filename.endsWith("god-dl.txt"), item.filename);
    t.eq(item.exists, true);
    t.eq(item.fileSize, 18);
    const q = await chrome.downloads.search({ query: ["god-dl"], orderBy: ["-startTime"], limit: 1 });
    t.eq(q[0]?.id, S.dl);
    return `${t.keys(item)} mime=${item.mime}`;
  });

  test("downloads.getFileIcon", async (t) => {
    const icon = await chrome.downloads.getFileIcon(S.dl, { size: 16 });
    t.ok(String(icon).startsWith("data:image/png"), String(icon).slice(0, 30));
  });

  test("downloads.onDeterminingFilename", async (t, c) => {
    const listener = (item, suggest) => {
      suggest({ filename: "god-renamed.txt", conflictAction: "overwrite" });
    };
    chrome.downloads.onDeterminingFilename.addListener(listener);
    try {
      const id = await chrome.downloads.download({ url: `${c.site}/download.txt` });
      const [d] = await t.event(chrome.downloads.onChanged, null, { filter: (d) => d.id === id && d.filename });
      t.ok(d.filename.current.endsWith("god-renamed.txt"), d.filename.current);
      S.renamed = id;
    } finally {
      chrome.downloads.onDeterminingFilename.removeListener(listener);
    }
  });

  test("downloads.pause/resume/cancel", async (t, c) => {
    const id = await chrome.downloads.download({ url: `${c.site}/slow-download.bin` });
    await t.sleep(400);
    await chrome.downloads.pause(id);
    t.eq((await chrome.downloads.search({ id }))[0].paused, true, "paused");
    await chrome.downloads.resume(id);
    t.eq((await chrome.downloads.search({ id }))[0].paused, false, "resumed");
    const [d] = await t.event(chrome.downloads.onChanged, () => chrome.downloads.cancel(id), { filter: (d) => d.id === id && d.state });
    t.eq(d.state.current, "interrupted");
    const [item] = await chrome.downloads.search({ id });
    t.eq(item.error, "USER_CANCELED");
    S.canceled = id;
  }, { timeout: 15000 });

  test("downloads.onChanged#bytes", async (t, c) => {
    const id = await chrome.downloads.download({ url: `${c.site}/slow-download.bin` });
    const deltas = [];
    const fn = (d) => d.id === id && deltas.push(Object.keys(d).filter((k) => k !== "id").sort().join("+"));
    chrome.downloads.onChanged.addListener(fn);
    await t.sleep(1500);
    chrome.downloads.onChanged.removeListener(fn);
    await chrome.downloads.cancel(id);
    return [...new Set(deltas)].join(" ");
  });

  test("downloads.resume#complete", (t) => t.outcome(chrome.downloads.resume(S.dl)));
  test("downloads.pause#complete", (t) => t.outcome(chrome.downloads.pause(S.dl)));
  test("downloads.acceptDanger#safe", (t) => t.outcome(chrome.downloads.acceptDanger(S.dl)));
  test("downloads.open#no-gesture", (t) => t.outcome(chrome.downloads.open(S.dl)));

  test("downloads.removeFile", async (t) => {
    await chrome.downloads.removeFile(S.renamed);
    await t.sleep(300);
    const [item] = await chrome.downloads.search({ id: S.renamed });
    t.eq(item.exists, false);
  });

  test("downloads.erase+onErased", async (t) => {
    const [id] = await t.event(chrome.downloads.onErased, async () => {
      S.erased = await chrome.downloads.erase({ id: S.canceled });
    });
    t.eq(id, S.canceled);
    t.eq(S.erased, [S.canceled]);
    t.eq(await chrome.downloads.search({ id: S.canceled }), []);
  });

  test("downloads.setUiOptions", async (t) => {
    t.eq(await chrome.downloads.setUiOptions({ enabled: false }), undefined);
    await chrome.downloads.setUiOptions({ enabled: true });
  });

  test("downloads.setShelfEnabled", async (t) => {
    const res = await new Promise((r) => {
      try {
        chrome.downloads.setShelfEnabled(true);
        r("called");
      } catch (error) {
        r(`throws: ${error.message}`);
      }
    });
    return res;
  });

  test("downloads.show/showDefaultFolder", (t) => {
    t.ok(typeof chrome.downloads.show === "function" && typeof chrome.downloads.showDefaultFolder === "function", "missing");
    return "present (not called: opens Finder)";
  });

  test("downloads.download#invalid-url", (t) => t.rejects(chrome.downloads.download({ url: "notaurl" })));

  test("downloads.download#bad-filename", (t, c) => t.rejects(chrome.downloads.download({ url: `${c.site}/download.txt`, filename: "../escape.txt" })));

  test("topSites.get", async (t) => {
    const sites = await chrome.topSites.get();
    t.type(sites, "array");
    sites.forEach((s) => t.shape(s, { url: "string", title: "string" }));
    return "array";
  });

  test("search.query", async (t) => {
    const before = new Set((await chrome.tabs.query({})).map((x) => x.id));
    await chrome.search.query({ text: "god extension", disposition: "NEW_TAB" });
    let tab;
    for (let i = 0; i < 25 && !tab; i++) {
      await t.sleep(200);
      tab = (await chrome.tabs.query({})).find((x) => !before.has(x.id));
    }
    t.ok(tab, "no new tab");
    const url = tab.pendingUrl || tab.url;
    await chrome.tabs.remove(tab.id);
    return `host=${new URL(url).host}`;
  });

  test("search.query#bad-disposition", (t) => t.rejects(async () => chrome.search.query({ text: "x", disposition: "NEW_TAB", tabId: 1 })));

  test("browsingData.settings", async (t) => {
    const s = await chrome.browsingData.settings();
    t.shape(s, { options: "object", dataToRemove: "object", dataRemovalPermitted: "object" });
    return `toRemove=${t.keys(s.dataToRemove)}`;
  });

  for (const fn of ["removeAppcache", "removeCache", "removeCacheStorage", "removeCookies", "removeDownloads", "removeFileSystems", "removeFormData", "removeHistory", "removeIndexedDB", "removeLocalStorage", "removePasswords", "removePluginData", "removeServiceWorkers", "removeWebSQL"]) {
    test(`browsingData.${fn}`, async (t) => {
      return t.outcome(chrome.browsingData[fn]({ since: Date.now() - 1000 }));
    });
  }

  test("browsingData.remove", async (t, c) => {
    await chrome.cookies.set({ url: `${c.site}/`, name: "wipe-me", value: "1" });
    await chrome.browsingData.remove({ since: 0 }, { cookies: true });
    t.eq(await chrome.cookies.get({ url: `${c.site}/`, name: "wipe-me" }), null);
  });

  test("browsingData.removeCookies#origins", async (t, c) => {
    await chrome.cookies.set({ url: `${c.site}/`, name: "origin-keep", value: "1" });
    await chrome.cookies.set({ url: "https://example.com/", name: "origin-wipe", value: "1" });
    await chrome.browsingData.removeCookies({ origins: ["https://example.com"] });
    t.eq(await chrome.cookies.get({ url: "https://example.com/", name: "origin-wipe" }), null, "filtered origin kept");
    t.ok(await chrome.cookies.get({ url: `${c.site}/`, name: "origin-keep" }), "other origin wiped");
  });

  test("browsingData.removeHistory#since", async (t, c) => {
    await chrome.history.addUrl({ url: `${c.site}/old-visit` });
    await t.sleep(50);
    const since = Date.now();
    await chrome.history.addUrl({ url: `${c.site}/new-visit` });
    await chrome.browsingData.removeHistory({ since });
    const urls = (await chrome.history.search({ text: "", startTime: 0 })).map((i) => i.url);
    t.ok(!urls.includes(`${c.site}/new-visit`), "new visit kept");
    t.ok(urls.includes(`${c.site}/old-visit`), "old visit wiped (time range ignored)");
  });

  test("browsingData.remove#bad-origin-type", (t) => t.rejects(chrome.browsingData.remove({ origins: ["https://example.com"] }, { history: true })));

  test("readingList.addEntry", async (t, c) => {
    t.eq(await chrome.readingList.addEntry({ url: `${c.site}/read`, title: "Read me", hasBeenRead: false }), undefined);
  });
  test("readingList.query", async (t, c) => {
    const [e] = await chrome.readingList.query({ url: `${c.site}/read` });
    t.shape(e, { url: "string", title: "string", hasBeenRead: "boolean", creationTime: "number", lastUpdateTime: "number" });
  });
  test("readingList.updateEntry", async (t, c) => {
    await chrome.readingList.updateEntry({ url: `${c.site}/read`, hasBeenRead: true });
  });
  test("readingList.removeEntry", async (t, c) => {
    await chrome.readingList.removeEntry({ url: `${c.site}/read` });
  });
  test("readingList.events", async (t, c) => {
    await t.event(chrome.readingList.onEntryAdded, () => chrome.readingList.addEntry({ url: `${c.site}/read2`, title: "x", hasBeenRead: false }));
    await t.event(chrome.readingList.onEntryUpdated, () => chrome.readingList.updateEntry({ url: `${c.site}/read2`, title: "y" }));
    await t.event(chrome.readingList.onEntryRemoved, () => chrome.readingList.removeEntry({ url: `${c.site}/read2` }));
  });
})();
