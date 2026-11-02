// runtime, i18n, storage, extension, alarms, idle, power, permissions, management, events
(() => {
  const { test } = god;
  const ALL = ["sw", "page", "popup", "options", "sidepanel"];

  test("runtime.id", (t, c) => {
    t.eq(chrome.runtime.id, c.ids.god);
    return "id ok";
  }, { ctx: [...ALL, "cs", "offscreen"] });

  test("runtime.getURL", (t, c) => {
    t.eq(chrome.runtime.getURL("/x/y.html?q=1"), `chrome-extension://${c.ids.god}/x/y.html?q=1`);
    t.eq(chrome.runtime.getURL("z.js"), `chrome-extension://${c.ids.god}/z.js`);
  }, { ctx: [...ALL, "cs", "offscreen"] });

  test("runtime.getManifest", (t) => {
    const m = chrome.runtime.getManifest();
    t.eq(m.manifest_version, 3);
    t.eq(m.name, "God Extension");
    t.type(m.permissions, "array");
    return `perms=${m.permissions.length}`;
  }, { ctx: [...ALL, "cs"] });

  test("runtime.getVersion", (t) => {
    t.eq(chrome.runtime.getVersion(), "1.0");
  }, { ctx: ["sw", "cs"] });

  test("runtime.dynamicId", (t, c) => {
    t.type(chrome.runtime.dynamicId, "string");
    return chrome.runtime.dynamicId === c.ids.god ? "equals id" : "differs from id";
  }, { ctx: ["sw", "cs"] });

  test("runtime.getPlatformInfo", async (t) => {
    const info = await chrome.runtime.getPlatformInfo();
    t.shape(info, { os: "string", arch: "string", nacl_arch: "string?" });
    t.eq(info.os, "mac");
    return `${info.os}/${info.arch} keys=${t.keys(info)}`;
  });

  test("runtime.getPlatformInfo#callback", async (t) => {
    const { value, lastError } = await t.callback((cb) => chrome.runtime.getPlatformInfo(cb));
    t.eq(lastError, null);
    t.eq(value.os, "mac");
  });

  test("runtime.getContexts", async (t) => {
    const contexts = await chrome.runtime.getContexts({});
    t.type(contexts, "array");
    const bg = contexts.find((x) => x.contextType === "BACKGROUND");
    t.ok(bg, "no BACKGROUND context");
    t.shape(bg, { contextId: "string", contextType: "string", documentOrigin: "string?", documentUrl: "string?", frameId: "number", incognito: "boolean", tabId: "number", windowId: "number" });
    t.eq(bg.tabId, -1);
    return t.keys(bg);
  });

  test("runtime.getContexts#filter", async (t) => {
    const only = await chrome.runtime.getContexts({ contextTypes: ["BACKGROUND"] });
    t.ok(only.every((x) => x.contextType === "BACKGROUND"), "filter ignored");
    const none = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    return `bg=${only.length} offscreen=${none.length}`;
  });

  test("runtime.onInstalled", async (t) => {
    const seen = globalThis.godInstalled ?? [];
    t.ok(seen.length >= 1, "onInstalled never fired");
    t.eq(seen[0].reason, "install");
    return `count=${seen.length} reason=${seen[0].reason}`;
  });

  test("runtime.onStartup", async () => `count=${(globalThis.godStartup ?? []).length}`);

  test("runtime.setUninstallURL", async (t, c) => {
    t.eq(await chrome.runtime.setUninstallURL(`${c.site}/uninstalled`), undefined);
    t.eq(await chrome.runtime.setUninstallURL(""), undefined);
    return t.rejects(chrome.runtime.setUninstallURL("ftp://example.com/x"));
  });

  test("runtime.requestUpdateCheck", async (t) => {
    const res = await chrome.runtime.requestUpdateCheck();
    t.shape(res, { status: "string" });
    return res.status;
  });

  test("runtime.restart", (t) => t.outcome(chrome.runtime.restart()));
  test("runtime.restartAfterDelay", (t) => t.outcome(chrome.runtime.restartAfterDelay(-1)));

  test("runtime.getBackgroundPage", (t) => t.outcome(chrome.runtime.getBackgroundPage()), { ctx: ["page"] });

  test("runtime.getPackageDirectoryEntry", async (t) => {
    const entry = await new Promise((r) => chrome.runtime.getPackageDirectoryEntry(r));
    t.ok(entry && entry.isDirectory, "no directory entry");
    return "directory";
  }, { ctx: ["page"] });

  test("runtime.lastError#callback", async (t) => {
    const { value, lastError } = await t.callback((cb) => chrome.tabs.get(999999, cb));
    t.eq(value, undefined);
    t.ok(lastError, "lastError not set");
    t.eq(chrome.runtime.lastError, undefined, "lastError leaks after callback");
    return lastError;
  });

  test("runtime.lastError#promise", (t) => t.rejects(chrome.tabs.get(999999)));

  test("runtime.sendMessage#to-self-no-receiver", (t) => t.rejects(chrome.runtime.sendMessage({ kind: "nobody" }), /Receiving end does not exist/), { ctx: ["sw"] });

  test("runtime.sendMessage#page-to-sw", async (t) => {
    const reply = await chrome.runtime.sendMessage({ kind: "echo", value: 42 });
    t.eq(reply?.echo, 42);
    t.ok(reply.sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`), `sender.url ${reply.sender.url}`);
    t.eq(reply.sender.id, chrome.runtime.id);
    return t.keys(reply.sender);
  }, { ctx: ["page", "popup", "options", "sidepanel", "offscreen"] });

  test("runtime.sendMessage#async-reply", async (t) => {
    const reply = await chrome.runtime.sendMessage({ kind: "echo-async", value: "later" });
    t.eq(reply?.echo, "later");
  }, { ctx: ["page", "cs"] });

  test("runtime.sendMessage#promise-reply", async (t) => {
    const reply = await chrome.runtime.sendMessage({ kind: "echo-promise", value: "p" });
    t.eq(reply?.echo, "p");
    return "promise return";
  }, { ctx: ["page", "cs"] });

  test("runtime.connect#page-to-sw", async (t) => {
    const port = chrome.runtime.connect({ name: "god-port" });
    t.eq(port.name, "god-port");
    const reply = await new Promise((resolve, reject) => {
      port.onMessage.addListener((m) => resolve(m));
      port.onDisconnect.addListener(() => reject(new Error("disconnected")));
      port.postMessage({ ping: 1 });
      setTimeout(() => reject(new Error("no port reply")), 5000);
    });
    t.eq(reply.pong, 1);
    t.eq(reply.name, "god-port");
    port.disconnect();
    return t.keys(reply.sender);
  }, { ctx: ["page", "cs", "popup", "sidepanel"] });

  test("runtime.Port.onDisconnect", async (t) => {
    const port = chrome.runtime.connect({ name: "god-disconnect-me" });
    const [p] = await t.event(port.onDisconnect, () => port.postMessage({ please: "disconnect" }));
    t.eq(p.name, "god-disconnect-me");
    return `lastError=${chrome.runtime.lastError?.message ?? "none"}`;
  }, { ctx: ["page", "cs"] });

  test("runtime.connect#no-receiver", async (t) => {
    const port = chrome.runtime.connect(chrome.runtime.id, { name: "nobody-home" });
    const [p] = await t.event(port.onDisconnect, null);
    return `disconnect lastError=${chrome.runtime.lastError?.message ?? "none"} name=${p.name}`;
  }, { ctx: ["sw"] });

  test("runtime.openOptionsPage", async (t, c) => {
    const [tab] = await t.event(chrome.tabs.onUpdated, () => chrome.runtime.openOptionsPage(), {
      filter: (id, info, tab) => (tab.url ?? tab.pendingUrl ?? "").endsWith("/options.html"),
    });
    t.ok(tab, "no options tab");
    globalThis.godOptionsTab = tab;
    return "options tab opened";
  }, { timeout: 12000 });

  test("i18n.getMessage", (t, c) => {
    t.eq(chrome.i18n.getMessage("plain"), "plain text");
    t.eq(chrome.i18n.getMessage("greeting", ["Rob"]), "Hello Rob");
    t.eq(chrome.i18n.getMessage("greeting", "Solo"), "Hello Solo");
    t.eq(chrome.i18n.getMessage("missing_key"), "");
    t.eq(chrome.i18n.getMessage("@@extension_id"), c.ids.god);
    t.type(chrome.i18n.getMessage("@@ui_locale"), "string");
    t.eq(chrome.i18n.getMessage("@@bidi_dir"), "ltr");
    return chrome.i18n.getMessage("@@ui_locale");
  }, { ctx: [...ALL, "cs"] });

  test("i18n.getUILanguage", (t) => {
    const lang = chrome.i18n.getUILanguage();
    t.type(lang, "string");
    return lang;
  }, { ctx: ["sw", "cs"] });

  test("i18n.getAcceptLanguages", async (t) => {
    const langs = await chrome.i18n.getAcceptLanguages();
    t.type(langs, "array");
    t.ok(langs.length > 0, "empty");
    return langs.join(",");
  }, { ctx: ["sw", "cs"] });

  test("i18n.detectLanguage", async (t) => {
    const res = await chrome.i18n.detectLanguage("Ceci est un texte assez long écrit en français pour que la détection fonctionne correctement.");
    t.shape(res, { isReliable: "boolean", languages: "array" });
    t.eq(res.languages[0]?.language, "fr");
    return `${res.languages[0].language} reliable=${res.isReliable}`;
  }, { ctx: ["sw", "cs"] });

  for (const area of ["local", "session", "sync"]) {
    test(`storage.${area}.set/get`, async (t) => {
      const s = chrome.storage[area];
      await s.set({ [`god_${area}`]: { n: 1, a: [1, "x"] }, [`god_${area}_2`]: "two" });
      t.eq(await s.get(`god_${area}`), { [`god_${area}`]: { n: 1, a: [1, "x"] } });
      t.eq(await s.get([`god_${area}_2`, "absent"]), { [`god_${area}_2`]: "two" });
      t.eq(await s.get({ absent: "default" }), { absent: "default" });
      const all = await s.get(null);
      t.ok(`god_${area}` in all, "get(null) misses key");
    }, { ctx: area === "session" ? ["sw", "page"] : ["sw", "page", "cs"] });

    test(`storage.${area}.getKeys`, async (t) => {
      const keys = await chrome.storage[area].getKeys();
      t.type(keys, "array");
      t.ok(keys.includes(`god_${area}`), `keys ${keys}`);
    });

    test(`storage.${area}.getBytesInUse`, async (t) => {
      const n = await chrome.storage[area].getBytesInUse(`god_${area}_2`);
      t.type(n, "number");
      return `bytes=${n}`;
    });

    test(`storage.${area}.remove`, async (t) => {
      await chrome.storage[area].remove(`god_${area}_2`);
      t.eq(await chrome.storage[area].get(`god_${area}_2`), {});
    });

    test(`storage.${area}.onChanged`, async (t) => {
      const [changes] = await t.event(chrome.storage[area].onChanged, () => chrome.storage[area].set({ [`god_${area}_ev`]: Math.random() }));
      t.ok(`god_${area}_ev` in changes, "missing key");
      t.shape(changes[`god_${area}_ev`], { newValue: "number" });
    });

    test(`storage.onChanged#${area}`, async (t) => {
      const [changes, name] = await t.event(chrome.storage.onChanged, () => chrome.storage[area].set({ [`god_${area}_ev2`]: 5 }), { filter: (ch, n) => n === area });
      t.eq(name, area);
      t.eq(changes[`god_${area}_ev2`].newValue, 5);
    });

    test(`storage.${area}.clear`, async (t) => {
      await chrome.storage[area].clear();
      t.eq(await chrome.storage[area].get(null), {});
    });

    test(`storage.${area}.QUOTA_BYTES`, () => `${chrome.storage[area].QUOTA_BYTES}`);
  }

  test("storage.sync.constants", (t) => {
    const s = chrome.storage.sync;
    return [s.QUOTA_BYTES, s.QUOTA_BYTES_PER_ITEM, s.MAX_ITEMS, s.MAX_WRITE_OPERATIONS_PER_HOUR, s.MAX_WRITE_OPERATIONS_PER_MINUTE].join(",");
  });

  test("storage.sync.QUOTA_BYTES_PER_ITEM#enforced", (t) => t.rejects(chrome.storage.sync.set({ big: "x".repeat(9000) }), /quota/i));

  test("storage.session.setAccessLevel", async (t) => {
    await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });
    await chrome.storage.session.set({ god_shared: "visible-to-cs" });
  });

  test("storage.session#untrusted-access", async (t) => {
    const v = await chrome.storage.session.get("god_shared");
    t.eq(v.god_shared, "visible-to-cs");
  }, { ctx: ["cs"] });

  test("storage.managed.get", async (t) => {
    t.eq(await chrome.storage.managed.get(null), {});
  });

  test("storage.managed.set", (t) => t.rejects(chrome.storage.managed.set({ a: 1 })));
  test("storage.local.setAccessLevel", async (t) => {
    const r = await t.outcome(chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }));
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" }).catch(() => {});
    return r;
  });

  test("extension.inIncognitoContext", (t) => {
    t.eq(chrome.extension.inIncognitoContext, false);
  }, { ctx: ["sw", "page", "cs"] });

  test("extension.isAllowedIncognitoAccess", async () => `${await chrome.extension.isAllowedIncognitoAccess()}`);
  test("extension.isAllowedFileSchemeAccess", async () => `${await chrome.extension.isAllowedFileSchemeAccess()}`);
  test("extension.setUpdateUrlData", (t) => {
    t.eq(chrome.extension.setUpdateUrlData("god=1"), undefined);
  });

  test("extension.getViews", (t) => {
    const views = chrome.extension.getViews();
    t.ok(views.includes(window), "own window missing");
    const tabs = chrome.extension.getViews({ type: "tab" });
    return `all=${views.length >= 1} tabSelf=${tabs.includes(window)}`;
  }, { ctx: ["page"] });

  test("extension.getViews#popup", (t) => {
    const popups = chrome.extension.getViews({ type: "popup" });
    t.ok(popups.includes(window), "popup view missing");
  }, { ctx: ["popup"] });

  test("extension.getBackgroundPage", (t) => `${chrome.extension.getBackgroundPage()}`, { ctx: ["page"] });

  test("alarms.create/get", async (t) => {
    await chrome.alarms.create("god-a", { delayInMinutes: 5, periodInMinutes: 10 });
    const a = await chrome.alarms.get("god-a");
    t.shape(a, { name: "string", scheduledTime: "number", periodInMinutes: "number" });
    t.eq(a.periodInMinutes, 10);
    return t.keys(a);
  });

  test("alarms.getAll", async (t) => {
    const all = await chrome.alarms.getAll();
    t.ok(all.some((a) => a.name === "god-a"), "missing");
  });

  test("alarms.onAlarm", async (t) => {
    const [alarm] = await t.event(chrome.alarms.onAlarm, () => chrome.alarms.create("god-fire", { when: Date.now() + 300 }), { filter: (a) => a.name === "god-fire", timeout: 8000 });
    t.shape(alarm, { name: "string", scheduledTime: "number" });
    t.eq(await chrome.alarms.get("god-fire"), undefined, "one-shot alarm still present");
  }, { timeout: 12000 });

  test("alarms.clear", async (t) => {
    t.eq(await chrome.alarms.clear("god-a"), true);
    t.eq(await chrome.alarms.clear("god-a"), false);
  });

  test("alarms.clearAll", async (t) => {
    await chrome.alarms.create("god-b", { delayInMinutes: 1 });
    t.eq(await chrome.alarms.clearAll(), true);
    t.eq((await chrome.alarms.getAll()).length, 0);
  });

  test("idle.queryState", async (t) => {
    const state = await chrome.idle.queryState(60);
    t.ok(["active", "idle", "locked"].includes(state), state);
    return "state ok";
  });
  test("idle.setDetectionInterval", (t) => {
    t.eq(chrome.idle.setDetectionInterval(30), undefined);
  });

  test("power.requestKeepAwake", (t) => {
    t.eq(chrome.power.requestKeepAwake("system"), undefined);
  });
  test("power.releaseKeepAwake", (t) => {
    t.eq(chrome.power.releaseKeepAwake(), undefined);
  });

  test("permissions.getAll", async (t) => {
    const all = await chrome.permissions.getAll();
    t.shape(all, { permissions: "array", origins: "array" });
    t.ok(all.origins.includes("<all_urls>"), `origins ${all.origins}`);
    return `origins=${all.origins.sort().join(",")} permissions=${all.permissions.sort().join(",")}`;
  });

  test("permissions.contains", async (t) => {
    t.eq(await chrome.permissions.contains({ permissions: ["tabs"] }), true);
    t.eq(await chrome.permissions.contains({ origins: ["https://example.com/*"] }), true);
    const optional = await chrome.permissions.contains({ origins: ["https://optional.test/*"] });
    return `optional-covered-by-all_urls=${optional} ${await t.rejects(chrome.permissions.contains({ permissions: ["notARealPermission"] }))}`;
  });

  test("permissions.request#no-gesture", (t) => t.rejects(chrome.permissions.request({ origins: ["https://optional.test/*"] }), /user gesture/));

  test("permissions.remove#required", (t) => t.rejects(chrome.permissions.remove({ permissions: ["tabs"] }), /required/));

  test("permissions.remove#optional", () => chrome.permissions.remove({ origins: ["https://optional.test/*"] }).then(String, (e) => `rejects: ${e.message}`));

  test("permissions.remove#undeclared", (t) => t.rejects(chrome.permissions.remove({ origins: ["https://not-declared.test/*"] })));

  test("permissions.addHostAccessRequest", async (t, c) => t.rejects(chrome.permissions.addHostAccessRequest({ tabId: 999999 })));
  test("permissions.removeHostAccessRequest", async (t, c) => t.rejects(chrome.permissions.removeHostAccessRequest({ tabId: 999999 })));

  test("management.getSelf", async (t, c) => {
    const self = await chrome.management.getSelf();
    t.shape(self, { id: "string", name: "string", shortName: "string", description: "string", version: "string", mayDisable: "boolean", enabled: "boolean", isApp: "boolean", type: "string", offlineEnabled: "boolean", optionsUrl: "string", permissions: "array", hostPermissions: "array", installType: "string", icons: "array?" });
    t.eq(self.id, c.ids.god);
    t.eq(self.installType, "development");
    t.eq(self.type, "extension");
    return `${t.keys(self)} options=${self.optionsUrl.replace(/^chrome-extension:\/\/[a-p]+/, "")}`;
  });

  test("management.getAll", async (t, c) => {
    const all = await chrome.management.getAll();
    t.ok(all.some((e) => e.id === c.ids.god), "self missing");
    t.ok(all.some((e) => e.id === c.ids.peer), "peer missing");
    return `ids=${all.map((e) => Object.entries(c.ids).find(([, v]) => v === e.id)?.[0] ?? "other").sort().join(",")}`;
  });

  test("management.get", async (t, c) => {
    const peer = await chrome.management.get(c.ids.peer);
    t.eq(peer.name, "God Peer");
    return t.rejects(chrome.management.get("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
  });

  test("management.getPermissionWarningsById", async (t, c) => {
    const w = await chrome.management.getPermissionWarningsById(c.ids.peer);
    t.type(w, "array");
    return `count=${w.length}`;
  });

  test("management.getPermissionWarningsByManifest", async (t) => {
    const w = await chrome.management.getPermissionWarningsByManifest(godJson({ manifest_version: 3, name: "x", version: "1", permissions: ["history"] }));
    t.type(w, "array");
    t.ok(w.length >= 1, "no warning for history");
    return w.join(" | ");
  });

  test("management.setEnabled+onDisabled+onEnabled", async (t, c) => {
    const [off] = await t.event(chrome.management.onDisabled, () => chrome.management.setEnabled(c.ids.peer, false));
    t.eq(off.id, c.ids.peer);
    t.eq(off.enabled, false);
    const [on] = await t.event(chrome.management.onEnabled, () => chrome.management.setEnabled(c.ids.peer, true));
    t.eq(on.enabled, true);
  });

  test("management.setEnabled#unknown-id", (t) => t.rejects(chrome.management.setEnabled("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", false)));
  test("management.uninstall#no-gesture", (t, c) => t.rejects(chrome.management.uninstall(c.ids.noperm, { showConfirmDialog: false })));
  test("management.launchApp", (t, c) => t.rejects(chrome.management.launchApp(c.ids.peer)));
  test("management.createAppShortcut", (t, c) => t.rejects(chrome.management.createAppShortcut(c.ids.peer)));
  test("management.setLaunchType", (t, c) => t.rejects(chrome.management.setLaunchType(c.ids.peer, "OPEN_AS_REGULAR_TAB")));
  test("management.generateAppForLink", (t, c) => t.rejects(chrome.management.generateAppForLink(`${c.site}/page.html`, "x")));
  test("management.onInstalled", (t) => {
    t.ok(chrome.management.onInstalled && chrome.management.onUninstalled, "events missing");
  });

  test("events.Event#listener-api", (t) => {
    const e = chrome.tabs.onCreated;
    const fn = () => {};
    t.eq(e.hasListener(fn), false);
    e.addListener(fn);
    t.eq(e.hasListener(fn), true);
    t.eq(e.hasListeners(), true);
    e.removeListener(fn);
    t.eq(e.hasListener(fn), false);
  });

  test("events.Event#bad-listener", (t) => {
    try {
      chrome.tabs.onCreated.addListener("not a function");
      chrome.tabs.onCreated.removeListener("not a function");
    } catch (error) {
      return "throws";
    }
    return "accepted";
  });

  test("api#bad-arguments-throw-sync", (t) => {
    try {
      chrome.tabs.get("not-a-number");
    } catch (error) {
      return `throws sync: ${error.message.slice(0, 80)}`;
    }
    t.fail("no synchronous TypeError");
  });

  test("browser-namespace", (t) => {
    const b = globalThis.browser;
    if (!b) return "absent";
    t.eq(b.runtime.id, chrome.runtime.id);
    return `present same=${b === chrome}`;
  }, { ctx: ["sw", "page", "cs"] });
})();
