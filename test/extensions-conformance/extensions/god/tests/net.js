// declarativeNetRequest, webRequest, proxy, userScripts, declarativeContent
(() => {
  const { test } = god;
  const S = {};
  const pageTab = async () => (await chrome.tabs.query({ url: "http://localhost/*" }))[0];
  // Fetches from inside the test page, so requests carry a tab id like real page traffic.
  const pageFetch = async (url) => {
    const tab = await pageTab();
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [url],
      func: async (u) => {
        try {
          const res = await fetch(u, { cache: "no-store" });
          return { status: res.status, body: await res.text() };
        } catch (error) {
          return { error: String(error.message) };
        }
      },
    });
    return r.result;
  };
  god.pageFetch = pageFetch;

  test("declarativeNetRequest.constants", () => {
    const d = chrome.declarativeNetRequest;
    return ["DYNAMIC_RULESET_ID", "SESSION_RULESET_ID", "GUARANTEED_MINIMUM_STATIC_RULES", "MAX_NUMBER_OF_DYNAMIC_RULES", "MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES", "MAX_NUMBER_OF_SESSION_RULES", "MAX_NUMBER_OF_UNSAFE_SESSION_RULES", "MAX_NUMBER_OF_REGEX_RULES", "MAX_NUMBER_OF_STATIC_RULESETS", "MAX_NUMBER_OF_ENABLED_STATIC_RULESETS", "MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL", "GETMATCHEDRULES_QUOTA_INTERVAL", "MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES"].map((k) => `${k}=${d[k]}`).join(" ");
  });

  test("declarativeNetRequest.getEnabledRulesets", async (t) => {
    t.eq(await chrome.declarativeNetRequest.getEnabledRulesets(), ["static_on"]);
  });

  test("declarativeNetRequest#static-rule-blocks", async (t, c) => {
    const r = await pageFetch(`${c.site}/dnr-static-block`);
    t.ok(r.error, `not blocked: ${godJson(r)}`);
    const ok = await pageFetch(`${c.site}/dnr-static-off-block`);
    t.eq(ok.status, 200, "disabled ruleset blocked");
  });

  test("declarativeNetRequest.getAvailableStaticRuleCount", async (t) => {
    const n = await chrome.declarativeNetRequest.getAvailableStaticRuleCount();
    t.type(n, "number");
    return `${n}`;
  });

  test("declarativeNetRequest.updateStaticRules/getDisabledRuleIds", async (t, c) => {
    await chrome.declarativeNetRequest.updateStaticRules({ rulesetId: "static_on", disableRuleIds: [1] });
    t.eq(await chrome.declarativeNetRequest.getDisabledRuleIds({ rulesetId: "static_on" }), [1]);
    t.eq((await pageFetch(`${c.site}/dnr-static-block`)).status, 200, "disabled rule still blocks");
    await chrome.declarativeNetRequest.updateStaticRules({ rulesetId: "static_on", enableRuleIds: [1] });
    t.eq(await chrome.declarativeNetRequest.getDisabledRuleIds({ rulesetId: "static_on" }), []);
  });

  test("declarativeNetRequest.updateEnabledRulesets", async (t, c) => {
    await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: ["static_off"], disableRulesetIds: ["static_on"] });
    t.eq(await chrome.declarativeNetRequest.getEnabledRulesets(), ["static_off"]);
    t.ok((await pageFetch(`${c.site}/dnr-static-off-block`)).error, "newly enabled ruleset not applied");
    await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: ["static_on"], disableRulesetIds: ["static_off"] });
    t.eq(await chrome.declarativeNetRequest.getEnabledRulesets(), ["static_on"]);
  });

  test("declarativeNetRequest.updateEnabledRulesets#unknown", (t) => t.rejects(chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: ["nope"] })));

  test("declarativeNetRequest.updateDynamicRules/getDynamicRules", async (t, c) => {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [10, 11],
      addRules: [
        { id: 10, priority: 1, action: { type: "block" }, condition: { urlFilter: "/dnr-dyn-block", resourceTypes: ["xmlhttprequest"] } },
        { id: 11, priority: 1, action: { type: "redirect", redirect: { extensionPath: "/war.txt" } }, condition: { urlFilter: "/dnr-dyn-redirect", resourceTypes: ["xmlhttprequest"] } },
      ],
    });
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    t.eq(rules.map((r) => r.id).sort(), [10, 11]);
    const filtered = await chrome.declarativeNetRequest.getDynamicRules({ ruleIds: [11] });
    t.eq(filtered.length, 1);
    t.ok((await pageFetch(`${c.site}/dnr-dyn-block`)).error, "dynamic block rule not applied");
    const red = await pageFetch(`${c.site}/dnr-dyn-redirect`);
    t.eq(red.body?.trim(), "war", `redirect: ${godJson(red)}`);
  });

  test("declarativeNetRequest.updateDynamicRules#invalid", (t) => t.rejects(chrome.declarativeNetRequest.updateDynamicRules({ addRules: [{ id: 0, action: { type: "block" }, condition: {} }] })));

  test("declarativeNetRequest.updateSessionRules/getSessionRules", async (t, c) => {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [20],
      addRules: [{ id: 20, priority: 1, action: { type: "modifyHeaders", requestHeaders: [{ header: "x-god", operation: "set", value: "session-rule" }] }, condition: { urlFilter: "/echo-headers", resourceTypes: ["xmlhttprequest"] } }],
    });
    t.eq((await chrome.declarativeNetRequest.getSessionRules()).map((r) => r.id), [20]);
    const r = await pageFetch(`${c.site}/echo-headers`);
    t.eq(JSON.parse(r.body)["x-god"], "session-rule");
  });

  test("declarativeNetRequest.isRegexSupported", async (t) => {
    t.eq(await chrome.declarativeNetRequest.isRegexSupported({ regex: "a+b" }), { isSupported: true });
    const bad = await chrome.declarativeNetRequest.isRegexSupported({ regex: "(" });
    t.eq(bad.isSupported, false);
    return godJson(bad);
  });

  test("declarativeNetRequest.testMatchOutcome", async (t, c) => {
    const r = await chrome.declarativeNetRequest.testMatchOutcome({ url: `${c.site}/dnr-dyn-block`, type: "xmlhttprequest" });
    t.ok(r.matchedRules.some((m) => m.ruleId === 10), godJson(r));
    return godJson(r);
  });

  test("declarativeNetRequest.getMatchedRules", async (t) => {
    const tab = await pageTab();
    const r = await chrome.declarativeNetRequest.getMatchedRules({ tabId: tab.id });
    t.shape(r, { rulesMatchedInfo: "array" });
    t.ok(r.rulesMatchedInfo.length > 0, "nothing matched");
    t.shape(r.rulesMatchedInfo[0], { rule: "object", tabId: "number", timeStamp: "number" });
    return `count>0 keys=${t.keys(r.rulesMatchedInfo[0])}`;
  });

  test("declarativeNetRequest.onRuleMatchedDebug", async (t, c) => {
    const [info] = await t.event(chrome.declarativeNetRequest.onRuleMatchedDebug, () => pageFetch(`${c.site}/dnr-dyn-block`), { filter: (i) => i.rule.ruleId === 10 });
    t.shape(info, { request: "object", rule: "object" });
    t.eq(info.rule.rulesetId, "_dynamic");
    return `request=${t.keys(info.request)}`;
  });

  test("declarativeNetRequest.setExtensionActionOptions", async (t) => {
    t.eq(await chrome.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: true }), undefined);
    await chrome.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: false });
  });

  test("declarativeNetRequest#cleanup", async () => {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [10, 11] });
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [20] });
  });

  test("webRequest.MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES", () => `${chrome.webRequest.MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES}`);

  test("webRequest.lifecycle", async (t, c) => {
    const seen = {};
    const filter = { urls: ["http://localhost/*"] };
    const handlers = {
      onBeforeRequest: [["requestBody"]],
      onBeforeSendHeaders: [["requestHeaders", "extraHeaders"]],
      onSendHeaders: [["requestHeaders"]],
      onHeadersReceived: [["responseHeaders"]],
      onResponseStarted: [["responseHeaders"]],
      onCompleted: [["responseHeaders"]],
    };
    const fns = Object.entries(handlers).map(([name, [extra]]) => {
      const fn = (d) => {
        if (d.url.includes("/echo-headers?wr=1")) seen[name] = d;
      };
      chrome.webRequest[name].addListener(fn, filter, extra);
      return [name, fn];
    });
    await pageFetch(`${c.site}/echo-headers?wr=1`);
    await t.sleep(400);
    fns.forEach(([name, fn]) => chrome.webRequest[name].removeListener(fn));
    t.eq(Object.keys(seen).sort(), Object.keys(handlers).sort());
    const b = seen.onBeforeRequest, done = seen.onCompleted;
    t.shape(b, { requestId: "string", url: "string", method: "string", frameId: "number", parentFrameId: "number", tabId: "number", type: "string", timeStamp: "number", initiator: "string?", documentId: "string?", documentLifecycle: "string?", frameType: "string?" });
    t.eq(b.type, "xmlhttprequest");
    t.ok(b.tabId > 0, `tabId ${b.tabId}`);
    t.shape(done, { statusCode: "number", fromCache: "boolean", ip: "string?", statusLine: "string", responseHeaders: "array" });
    t.ok(seen.onBeforeSendHeaders.requestHeaders.length > 0, "no requestHeaders");
    return `before=${t.keys(b)} | completed=${t.keys(done)}`;
  });

  test("webRequest.onBeforeRedirect", async (t, c) => {
    const [d] = await t.event(chrome.webRequest.onBeforeRedirect, () => pageFetch(`${c.site}/redirect`), { extra: [{ urls: ["http://localhost/*"] }], filter: (d) => d.url.endsWith("/redirect") });
    t.ok(d.redirectUrl.endsWith("/page.html?redirected=1"), d.redirectUrl);
    t.eq(d.statusCode, 302);
  });

  test("webRequest.onErrorOccurred", async (t, c) => {
    const [d] = await t.event(chrome.webRequest.onErrorOccurred, () => pageFetch(`${c.site}/dnr-static-block`), { extra: [{ urls: ["http://localhost/*"] }], filter: (d) => d.url.endsWith("/dnr-static-block") });
    return d.error;
  });

  test("webRequest.onAuthRequired", async (t, c) => {
    const fn = (details, callback) => callback({ authCredentials: { username: "god", password: "pw" } });
    chrome.webRequest.onAuthRequired.addListener(fn, { urls: ["http://localhost/*"] }, ["asyncBlocking"]);
    try {
      const r = await pageFetch(`${c.site}/basic-auth`);
      t.eq(r.status, 200, godJson(r));
      t.eq(r.body, "authorized god");
    } finally {
      chrome.webRequest.onAuthRequired.removeListener(fn);
    }
  });

  test("webRequest#blocking-mv3", (t) => {
    const fn = () => ({});
    try {
      chrome.webRequest.onBeforeRequest.addListener(fn, { urls: ["http://localhost/nothing-matches*"] }, ["blocking"]);
      chrome.webRequest.onBeforeRequest.removeListener(fn);
    } catch (error) {
      return `throws: ${error.message}`;
    }
    return "accepted";
  });

  test("webRequest#filter-types", async (t, c) => {
    const seen = [];
    const fn = (d) => d.url.includes("wr=types") && seen.push(d.type);
    chrome.webRequest.onBeforeRequest.addListener(fn, { urls: ["http://localhost/*"], types: ["image"] });
    await pageFetch(`${c.site}/echo-headers?wr=types`);
    await t.sleep(300);
    chrome.webRequest.onBeforeRequest.removeListener(fn);
    t.eq(seen, []);
  });

  test("webRequest.handlerBehaviorChanged", async (t) => {
    t.eq(await chrome.webRequest.handlerBehaviorChanged(), undefined);
  });

  test("webRequest.onActionIgnored", (t) => t.ok(chrome.webRequest.onActionIgnored?.addListener, "missing"));

  test("proxy.settings.get", async (t) => {
    const s = await chrome.proxy.settings.get({});
    t.shape(s, { value: "object", levelOfControl: "string" });
    return `${godJson(s.value)} ${s.levelOfControl}`;
  });

  test("proxy.settings.set+onChange", async (t) => {
    const [d] = await t.event(chrome.proxy.settings.onChange, () => chrome.proxy.settings.set({ value: { mode: "direct" }, scope: "regular" }));
    t.eq(d.value.mode, "direct");
    t.eq((await chrome.proxy.settings.get({})).levelOfControl, "controlled_by_this_extension");
  });

  test("proxy.settings.clear", async (t) => {
    await chrome.proxy.settings.clear({ scope: "regular" });
    t.eq((await chrome.proxy.settings.get({})).levelOfControl, "controllable_by_this_extension");
  });

  test("proxy.onProxyError", (t) => t.ok(chrome.proxy.onProxyError.addListener));

  test("userScripts.configureWorld", async (t) => {
    t.eq(await chrome.userScripts.configureWorld({ messaging: true }), undefined);
    await chrome.userScripts.configureWorld({ worldId: "god-world", csp: "script-src 'self'", messaging: true });
  });

  test("userScripts.getWorldConfigurations", async (t) => {
    const w = await chrome.userScripts.getWorldConfigurations();
    t.ok(w.some((x) => x.worldId === "god-world"), godJson(w));
  });

  test("userScripts.resetWorldConfiguration", async (t) => {
    await chrome.userScripts.resetWorldConfiguration("god-world");
    t.ok(!(await chrome.userScripts.getWorldConfigurations()).some((x) => x.worldId === "god-world"), "not reset");
  });

  test("userScripts.register", async (t, c) => {
    await chrome.userScripts.register([{ id: "god-us", matches: ["http://localhost/*"], js: [{ code: "document.documentElement.dataset.godUs = 'ran'; chrome.runtime.sendMessage({ kind: 'from-user-script' });" }], runAt: "document_end", world: "USER_SCRIPT" }]);
    const tab = await pageTab();
    const [msg, sender] = await t.event(chrome.runtime.onUserScriptMessage, async () => {
      await chrome.tabs.reload(tab.id);
    }, { filter: (m) => m?.kind === "from-user-script", timeout: 8000 });
    await god.waitComplete(tab.id);
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.documentElement.dataset.godUs });
    t.eq(r.result, "ran");
    t.eq(sender.tab?.id, tab.id);
    return "ran + onUserScriptMessage";
  });

  test("userScripts.getScripts", async (t) => {
    const s = await chrome.userScripts.getScripts({ ids: ["god-us"] });
    t.eq(s.length, 1);
    return t.keys(s[0]);
  });

  test("userScripts.update", async (t) => {
    await chrome.userScripts.update([{ id: "god-us", excludeMatches: ["http://localhost/nothing*"] }]);
    const [s] = await chrome.userScripts.getScripts({ ids: ["god-us"] });
    t.eq(s.excludeMatches, ["http://localhost/nothing*"]);
  });

  test("userScripts.execute", async (t) => {
    if (!chrome.userScripts.execute) return "absent";
    const tab = await pageTab();
    const r = await chrome.userScripts.execute({ target: { tabId: tab.id }, js: [{ code: "6*7" }] });
    t.eq(r[0].result, 42);
  });

  test("userScripts.unregister", async (t) => {
    await chrome.userScripts.unregister({ ids: ["god-us"] });
    t.eq(await chrome.userScripts.getScripts(), []);
  });

  test("userScripts.register#invalid", (t) => t.rejects(chrome.userScripts.register([{ id: "_bad", matches: ["http://localhost/*"], js: [{ code: "1" }] }])));

  test("runtime.onUserScriptConnect", (t) => t.ok(chrome.runtime.onUserScriptConnect?.addListener, "missing"));

  test("declarativeContent.classes", (t) => {
    const d = chrome.declarativeContent;
    t.ok(d.PageStateMatcher && d.ShowAction && d.SetIcon && d.RequestContentScript, "classes missing");
  });

  test("declarativeContent.onPageChanged.addRules/getRules/removeRules", async (t) => {
    const d = chrome.declarativeContent;
    await new Promise((r) => d.onPageChanged.removeRules(undefined, r));
    const added = await new Promise((r) => d.onPageChanged.addRules([{ id: "god-rule", conditions: [new d.PageStateMatcher({ pageUrl: { hostEquals: "localhost" } })], actions: [new d.ShowAction()] }], r));
    t.eq(added[0]?.id, "god-rule");
    const rules = await new Promise((r) => d.onPageChanged.getRules(r));
    t.eq(rules.length, 1);
    await new Promise((r) => d.onPageChanged.removeRules(["god-rule"], r));
    t.eq((await new Promise((r) => d.onPageChanged.getRules(r))).length, 0);
    return t.keys(rules[0]);
  });
})();
