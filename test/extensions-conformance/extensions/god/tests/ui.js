// action, contextMenus, notifications, sidePanel, commands, omnibox, offscreen, identity, debugger
(() => {
  const { test } = god;
  const S = {};
  const testTab = async () => (await chrome.tabs.query({ url: "http://localhost/*" }))[0];

  test("action.setTitle/getTitle", async (t) => {
    await chrome.action.setTitle({ title: "God global" });
    t.eq(await chrome.action.getTitle({}), "God global");
    const tab = await testTab();
    await chrome.action.setTitle({ title: "God tab", tabId: tab.id });
    t.eq(await chrome.action.getTitle({ tabId: tab.id }), "God tab");
    t.eq(await chrome.action.getTitle({}), "God global");
  });

  test("action.setBadgeText/getBadgeText", async (t) => {
    await chrome.action.setBadgeText({ text: "42" });
    t.eq(await chrome.action.getBadgeText({}), "42");
    const tab = await testTab();
    await chrome.action.setBadgeText({ text: "T", tabId: tab.id });
    t.eq(await chrome.action.getBadgeText({ tabId: tab.id }), "T");
  });

  test("action.setBadgeBackgroundColor/get", async (t) => {
    await chrome.action.setBadgeBackgroundColor({ color: "#ff0000" });
    t.eq(await chrome.action.getBadgeBackgroundColor({}), [255, 0, 0, 255]);
    await chrome.action.setBadgeBackgroundColor({ color: [0, 128, 0, 255] });
    t.eq(await chrome.action.getBadgeBackgroundColor({}), [0, 128, 0, 255]);
  });

  test("action.setBadgeTextColor/get", async (t) => {
    await chrome.action.setBadgeTextColor({ color: "#00ff00" });
    t.eq(await chrome.action.getBadgeTextColor({}), [0, 255, 0, 255]);
  });

  test("action.setBadgeBackgroundColor#invalid", (t) => t.rejects(chrome.action.setBadgeBackgroundColor({ color: "not-a-color" })));

  test("action.setIcon#imageData", async (t) => {
    const canvas = new OffscreenCanvas(16, 16);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#123456";
    ctx.fillRect(0, 0, 16, 16);
    t.eq(await chrome.action.setIcon({ imageData: ctx.getImageData(0, 0, 16, 16) }), undefined);
  });

  test("action.setIcon#path", async (t) => {
    t.eq(await chrome.action.setIcon({ path: { 16: "icons/16.png", 48: "icons/48.png" } }), undefined);
  });

  test("action.setIcon#missing-path", (t) => t.rejects(chrome.action.setIcon({ path: "icons/nope.png" })));

  test("action.setPopup/getPopup", async (t) => {
    t.eq(await chrome.action.getPopup({}), chrome.runtime.getURL("popup.html"));
    await chrome.action.setPopup({ popup: "page.html" });
    t.eq(await chrome.action.getPopup({}), chrome.runtime.getURL("page.html"));
    await chrome.action.setPopup({ popup: "popup.html" });
  });

  test("action.enable/disable/isEnabled", async (t) => {
    await chrome.action.disable();
    t.eq(await chrome.action.isEnabled(), false);
    const tab = await testTab();
    await chrome.action.enable(tab.id);
    t.eq(await chrome.action.isEnabled(tab.id), true);
    await chrome.action.enable();
    t.eq(await chrome.action.isEnabled(), true);
  });

  test("action.getUserSettings", async (t) => {
    const s = await chrome.action.getUserSettings();
    t.shape(s, { isOnToolbar: "boolean" });
    return `isOnToolbar=${s.isOnToolbar}`;
  });

  test("action.openPopup", async (t) => {
    const res = await chrome.action.openPopup().then(() => "resolved", (e) => `rejects: ${e.message}`);
    await t.sleep(800);
    const popups = await chrome.runtime.getContexts({ contextTypes: ["POPUP"] });
    S.popupOpened = popups.length > 0;
    return `${res} popupContext=${popups.length}`;
  });

  test("action.onClicked", (t) => t.ok(chrome.action.onClicked.addListener));
  test("action.onUserSettingsChanged", (t) => t.ok(chrome.action.onUserSettingsChanged?.addListener, "missing"));

  test("contextMenus.ACTION_MENU_TOP_LEVEL_LIMIT", () => `${chrome.contextMenus.ACTION_MENU_TOP_LEVEL_LIMIT}`);

  test("contextMenus.create", async (t) => {
    await chrome.contextMenus.removeAll();
    const id = await new Promise((resolve, reject) => {
      const ret = chrome.contextMenus.create({ id: "god-page", title: "God page item", contexts: ["page", "selection", "link", "image"] }, () => {
        chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(ret);
      });
    });
    t.eq(id, "god-page");
    chrome.contextMenus.create({ id: "god-parent", title: "God parent", contexts: ["all"] });
    chrome.contextMenus.create({ id: "god-child-check", parentId: "god-parent", title: "Check", type: "checkbox", checked: true, contexts: ["all"] });
    chrome.contextMenus.create({ id: "god-child-radio", parentId: "god-parent", title: "Radio", type: "radio", contexts: ["all"] });
    chrome.contextMenus.create({ id: "god-sep", parentId: "god-parent", type: "separator", contexts: ["all"] });
    chrome.contextMenus.create({ id: "god-action", title: "God action item", contexts: ["action"] });
    await new Promise((r) => chrome.contextMenus.create({ id: "god-sel", title: "Selected: %s", contexts: ["selection"], documentUrlPatterns: ["http://localhost/*"] }, r));
    t.eq(chrome.runtime.lastError, undefined);
  });

  test("contextMenus.create#duplicate", async (t) => {
    const err = await new Promise((r) => chrome.contextMenus.create({ id: "god-page", title: "dup" }, () => r(chrome.runtime.lastError?.message)));
    t.ok(err, "no lastError for duplicate id");
    return err;
  });

  test("contextMenus.create#missing-id-mv3", async (t) => {
    try {
      const id = chrome.contextMenus.create({ title: "no id" });
      return `created ${typeof id}`;
    } catch (error) {
      return `throws: ${error.message}`;
    }
  });

  test("contextMenus.update", async (t) => {
    t.eq(await chrome.contextMenus.update("god-page", { title: "God page item (updated)" }), undefined);
    return t.rejects(chrome.contextMenus.update("no-such-item", { title: "x" }));
  });

  test("contextMenus.remove", async (t) => {
    t.eq(await chrome.contextMenus.remove("god-sel"), undefined);
    return t.rejects(chrome.contextMenus.remove("god-sel"));
  });

  test("contextMenus.removeAll", async (t) => {
    chrome.contextMenus.create({ id: "temp", title: "temp" });
    t.eq(await chrome.contextMenus.removeAll(), undefined);
    chrome.contextMenus.create({ id: "god-page", title: "God page item", contexts: ["page", "selection", "link", "image"] });
    chrome.contextMenus.create({ id: "god-action", title: "God action item", contexts: ["action"] });
  });

  test("contextMenus.onClicked", (t) => t.ok(chrome.contextMenus.onClicked.addListener));

  test("notifications.create", async (t) => {
    const id = await chrome.notifications.create("god-n1", { type: "basic", iconUrl: "icons/48.png", title: "God", message: "hello", buttons: [{ title: "One" }], priority: 0 });
    t.eq(id, "god-n1");
    const auto = await chrome.notifications.create({ type: "basic", iconUrl: "icons/48.png", title: "Auto id", message: "x" });
    t.type(auto, "string");
    t.ok(auto.length > 0, "empty generated id");
    await chrome.notifications.clear(auto);
  });

  test("notifications.create#types", async (t) => {
    await chrome.notifications.create("god-list", { type: "list", iconUrl: "icons/48.png", title: "List", message: "m", items: [{ title: "a", message: "b" }] });
    await chrome.notifications.create("god-progress", { type: "progress", iconUrl: "icons/48.png", title: "P", message: "m", progress: 40 });
    await chrome.notifications.create("god-image", { type: "image", iconUrl: "icons/48.png", imageUrl: "icons/128.png", title: "I", message: "m" });
    for (const id of ["god-list", "god-progress", "god-image"]) await chrome.notifications.clear(id);
  });

  test("notifications.create#missing-fields", async (t) => {
    const r = await t.outcome(chrome.notifications.create("bad", { type: "basic", title: "no icon" }));
    await chrome.notifications.clear("bad");
    return r;
  });

  test("notifications.getAll", async (t) => {
    const all = await chrome.notifications.getAll();
    t.eq(all["god-n1"], true);
  });

  test("notifications.update", async (t) => {
    t.eq(await chrome.notifications.update("god-n1", { title: "God updated" }), true);
    t.eq(await chrome.notifications.update("nope", { title: "x" }), false);
  });

  test("notifications.clear+onClosed", async (t) => {
    const [id, byUser] = await t.event(chrome.notifications.onClosed, () => chrome.notifications.clear("god-n1"), { filter: (id) => id === "god-n1" });
    t.eq(byUser, false);
    t.eq(await chrome.notifications.clear("god-n1"), false);
  });

  test("notifications.getPermissionLevel", async (t) => {
    t.eq(await chrome.notifications.getPermissionLevel(), "granted");
  });

  test("notifications.events", (t) => t.ok(chrome.notifications.onClicked && chrome.notifications.onButtonClicked && chrome.notifications.onPermissionLevelChanged && chrome.notifications.onShowSettings));

  test("sidePanel.setOptions/getOptions", async (t) => {
    await chrome.sidePanel.setOptions({ path: "sidepanel.html", enabled: true });
    const o = await chrome.sidePanel.getOptions({});
    t.eq(o.enabled, true);
    const tab = await testTab();
    await chrome.sidePanel.setOptions({ tabId: tab.id, path: "sidepanel.html?tab=1", enabled: true });
    const per = await chrome.sidePanel.getOptions({ tabId: tab.id });
    return `global=${godJson(o)} tab=${godJson(per)}`;
  });

  test("sidePanel.setOptions#bad-path", async (t) => {
    const r = await chrome.sidePanel.setOptions({ path: "does-not-exist.html" }).then(() => "resolved", (e) => `rejects: ${e.message}`);
    await chrome.sidePanel.setOptions({ path: "sidepanel.html", enabled: true });
    return r;
  });

  test("sidePanel.setPanelBehavior/getPanelBehavior", async (t) => {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    t.eq(await chrome.sidePanel.getPanelBehavior(), { openPanelOnActionClick: true });
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  });

  test("sidePanel.open#no-gesture", async (t) => {
    const w = await chrome.windows.getCurrent();
    return t.rejects(chrome.sidePanel.open({ windowId: w.id }), /gesture/);
  });

  test("sidePanel.getLayout", async (t) => {
    const l = await chrome.sidePanel.getLayout();
    t.shape(l, { side: "string" });
    return l.side;
  });

  test("sidePanel.close#not-open", async (t) => {
    const w = await chrome.windows.getCurrent();
    return chrome.sidePanel.close({ windowId: w.id }).then(() => "resolved", (e) => `rejects: ${e.message}`);
  });

  test("sidePanel.events", (t) => t.ok(chrome.sidePanel.onOpened?.addListener && chrome.sidePanel.onClosed?.addListener, "missing"));

  test("commands.getAll", async (t) => {
    const all = await chrome.commands.getAll();
    const byName = Object.fromEntries(all.map((x) => [x.name, x]));
    t.ok(byName["god-command"], "god-command missing");
    t.shape(byName["god-command"], { name: "string", description: "string", shortcut: "string" });
    t.eq(byName["god-command"].description, "God command");
    t.eq(byName["god-unbound"]?.shortcut, "");
    return all.map((x) => `${x.name}=${x.shortcut}`).sort().join(" ");
  });

  test("commands.onCommand", (t) => t.ok(chrome.commands.onCommand.addListener));

  test("omnibox.setDefaultSuggestion", async (t) => {
    t.eq(await chrome.omnibox.setDefaultSuggestion({ description: "God: <match>%s</match>" }), undefined);
  });

  test("omnibox.setDefaultSuggestion#bad-xml", (t) => t.rejects(chrome.omnibox.setDefaultSuggestion({ description: "<match>unclosed" })));

  test("omnibox.sendSuggestions", (t) => {
    t.ok(typeof chrome.omnibox.sendSuggestions === "function", "missing");
  });

  test("omnibox.events", (t) => {
    for (const e of ["onInputStarted", "onInputChanged", "onInputEntered", "onInputCancelled", "onDeleteSuggestion", "onActionExecuted"]) t.ok(chrome.omnibox[e]?.addListener, `${e} missing`);
  });

  test("offscreen.hasDocument", async (t) => {
    t.eq(await chrome.offscreen.hasDocument(), false);
  });

  test("offscreen.createDocument", async (t) => {
    await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["DOM_PARSER"], justification: "god test" });
    t.eq(await chrome.offscreen.hasDocument(), true);
    const ctx = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    t.eq(ctx.length, 1);
    t.eq(ctx[0].documentUrl, chrome.runtime.getURL("offscreen.html"));
  });

  test("offscreen.createDocument#second", (t) => t.rejects(chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["DOM_PARSER"], justification: "again" }), /single offscreen/));

  test("offscreen.messaging", async (t) => {
    const reply = await chrome.runtime.sendMessage({ kind: "offscreen-parse", html: "<p>parsed by offscreen</p>" });
    t.eq(reply?.text, "parsed by offscreen");
  });

  test("offscreen.closeDocument", async (t) => {
    await t.sleep(1500);
    await chrome.offscreen.closeDocument();
    t.eq(await chrome.offscreen.hasDocument(), false);
    return t.rejects(chrome.offscreen.closeDocument());
  }, { timeout: 12000 });

  test("offscreen.createDocument#bad-reason", (t) => t.rejects(async () => chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["NOT_A_REASON"], justification: "x" })));

  test("identity.getRedirectURL", (t, c) => {
    t.eq(chrome.identity.getRedirectURL(), `https://${c.ids.god}.chromiumapp.org/`);
    t.eq(chrome.identity.getRedirectURL("cb"), `https://${c.ids.god}.chromiumapp.org/cb`);
  });

  test("identity.launchWebAuthFlow#redirect", async (t, c) => {
    const url = await chrome.identity.launchWebAuthFlow({ url: `${c.site}/auth-redirect?to=${encodeURIComponent(chrome.identity.getRedirectURL("cb"))}`, interactive: false });
    t.eq(url, `${chrome.identity.getRedirectURL("cb")}?code=42`);
  }, { timeout: 15000 });

  test("identity.launchWebAuthFlow#needs-interaction", (t, c) => t.rejects(chrome.identity.launchWebAuthFlow({ url: `${c.site}/auth-callback`, interactive: false })), { timeout: 15000 });

  test("identity.getAuthToken", (t) => t.rejects(chrome.identity.getAuthToken({ interactive: false })));
  test("identity.getProfileUserInfo", async (t) => godJson(await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" })));
  test("identity.removeCachedAuthToken", async (t) => `${await chrome.identity.removeCachedAuthToken({ token: "x" })}`);
  test("identity.clearAllCachedAuthTokens", async (t) => `${await chrome.identity.clearAllCachedAuthTokens()}`);
  test("identity.getAccounts", async (t) => (chrome.identity.getAccounts ? chrome.identity.getAccounts().then((a) => godJson(a), (e) => `rejects: ${e.message}`) : "absent"));
  test("identity.onSignInChanged", (t) => t.ok(chrome.identity.onSignInChanged.addListener));

  test("debugger.getTargets", async (t) => {
    const targets = await chrome.debugger.getTargets();
    const page = targets.find((x) => x.url.startsWith("http://localhost"));
    t.ok(page, "test page not listed");
    t.shape(page, { id: "string", type: "string", title: "string", url: "string", attached: "boolean", tabId: "number", faviconUrl: "string?", extensionId: "string?" });
    return `${t.keys(page)} types=${[...new Set(targets.map((x) => x.type))].sort().join(",")}`;
  });

  test("debugger.attach", async (t) => {
    S.tab = await testTab();
    t.eq(await chrome.debugger.attach({ tabId: S.tab.id }, "1.3"), undefined);
  });

  test("debugger.attach#twice", (t) => t.rejects(chrome.debugger.attach({ tabId: S.tab.id }, "1.3"), /already attached/));

  test("debugger.sendCommand", async (t) => {
    const r = await chrome.debugger.sendCommand({ tabId: S.tab.id }, "Runtime.evaluate", { expression: "6*7", returnByValue: true });
    t.eq(r.result.value, 42);
  });

  test("debugger.sendCommand#bad-method", (t) => t.rejects(chrome.debugger.sendCommand({ tabId: S.tab.id }, "No.suchMethod", {})));

  test("debugger.onEvent", async (t, c) => {
    await chrome.debugger.sendCommand({ tabId: S.tab.id }, "Page.enable");
    const [source, method, params] = await t.event(chrome.debugger.onEvent, () => chrome.debugger.sendCommand({ tabId: S.tab.id }, "Page.reload"), { filter: (s, m) => s.tabId === S.tab.id && m === "Page.frameNavigated" });
    t.eq(source.tabId, S.tab.id);
    t.ok(params.frame, "no frame");
  });

  test("debugger.detach", async (t) => {
    t.eq(await chrome.debugger.detach({ tabId: S.tab.id }), undefined);
    return t.rejects(chrome.debugger.sendCommand({ tabId: S.tab.id }, "Runtime.evaluate", { expression: "1" }), /not attached/);
  });

  test("debugger.onDetach", async (t, c) => {
    const tab = await god.openTab(t, `${c.site}/page.html?t=debugger`);
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
    const [source, reason] = await t.event(chrome.debugger.onDetach, () => chrome.tabs.remove(tab.id), { filter: (s) => s.tabId === tab.id });
    t.eq(reason, "target_closed");
  });

  test("debugger.attach#extension-page", async (t, c) => {
    const tab = await chrome.tabs.create({ url: `chrome-extension://${c.ids.peer}/page.html`, active: false });
    await t.sleep(800);
    try {
      return await t.rejects(chrome.debugger.attach({ tabId: tab.id }, "1.3"));
    } finally {
      chrome.tabs.remove(tab.id);
    }
  });

  test("debugger.attach#bad-version", (t) => t.rejects(chrome.debugger.attach({ tabId: S.tab.id }, "0.1")));
})();
