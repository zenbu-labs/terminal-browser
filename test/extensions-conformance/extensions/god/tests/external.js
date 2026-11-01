// cross-extension messaging, web_accessible_resources, native messaging, URL overrides
(() => {
  const { test } = god;
  const NATIVE = "com.god.echo";

  test("runtime.sendMessage#to-peer", async (t, c) => {
    const reply = await chrome.runtime.sendMessage(c.ids.peer, { kind: "ping" });
    t.eq(reply?.pong, true);
    t.eq(reply.sender.id, c.ids.god);
    t.ok(reply.sender.url?.startsWith(`chrome-extension://${c.ids.god}/`), `sender.url ${reply.sender.url}`);
    return t.keys(reply.sender);
  });

  test("runtime.connect#to-peer", async (t, c) => {
    const port = chrome.runtime.connect(c.ids.peer, { name: "to-peer" });
    const reply = await new Promise((resolve, reject) => {
      port.onMessage.addListener(resolve);
      port.onDisconnect.addListener(() => reject(new Error(`disconnected: ${chrome.runtime.lastError?.message}`)));
      port.postMessage({ ping: "port" });
      setTimeout(() => reject(new Error("no reply")), 5000);
    });
    t.eq(reply.pong, "port");
    t.eq(reply.name, "to-peer");
    port.disconnect();
  });

  test("runtime.sendMessage#to-missing-extension", (t) => t.rejects(chrome.runtime.sendMessage("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", { kind: "x" })));

  test("runtime.onMessageExternal#from-peer", async (t, c) => {
    const reply = await chrome.runtime.sendMessage(c.ids.peer, { kind: "message-god-back" });
    t.eq(reply?.god?.god, "external-reply", godJson(reply));
    const [msg, sender] = godEvents["runtime.onMessageExternal"].find(([m]) => m?.kind === "hello-from-peer");
    t.eq(sender.id, c.ids.peer);
    return `sender=${t.keys(sender)}`;
  });

  test("runtime.onConnectExternal#from-peer", async (t, c) => {
    const reply = await chrome.runtime.sendMessage(c.ids.peer, { kind: "connect-god-back" });
    t.eq(reply?.god?.god, "external-port-reply", godJson(reply));
    const [port] = godEvents["runtime.onConnectExternal"].at(-1);
    t.eq(port.name, "peer-port");
    t.eq(port.sender.id, c.ids.peer);
  });

  test("web_accessible_resources#extension_ids", async (t, c) => {
    const r = await chrome.runtime.sendMessage(c.ids.peer, { kind: "fetch-war", urls: [`chrome-extension://${c.ids.god}/war-ext.txt`, `chrome-extension://${c.ids.god}/war.txt`, `chrome-extension://${c.ids.god}/manifest.json`] });
    t.eq(r[0], "war-ext", "allowed by extension_ids");
    return r.map((x) => (x.startsWith("error") ? "blocked" : x)).join(",");
  });

  test("web_accessible_resources#from-page", async (t, c) => {
    const r = await god.pageFetch(`chrome-extension://${c.ids.god}/war.txt`);
    t.eq(r.body?.trim(), "war", godJson(r));
    const blocked = await god.pageFetch(`chrome-extension://${c.ids.god}/war-ext.txt`);
    t.ok(blocked.error, `not WAR for pages: ${godJson(blocked)}`);
  });

  test("runtime.sendNativeMessage", async (t) => {
    const reply = await chrome.runtime.sendNativeMessage(NATIVE, { hello: "native" });
    t.eq(reply?.echo?.hello, "native", godJson(reply));
    t.eq(reply.origin, `chrome-extension://${chrome.runtime.id}/`);
    return `argv-origin=${reply.origin === `chrome-extension://${chrome.runtime.id}/`}`;
  }, { timeout: 15000 });

  test("runtime.connectNative", async (t) => {
    const port = chrome.runtime.connectNative(NATIVE);
    const replies = [];
    await new Promise((resolve, reject) => {
      port.onMessage.addListener((m) => {
        replies.push(m);
        if (replies.length === 2) resolve();
      });
      port.onDisconnect.addListener(() => reject(new Error(`disconnected: ${chrome.runtime.lastError?.message}`)));
      port.postMessage({ n: 1 });
      port.postMessage({ n: 2 });
      setTimeout(() => reject(new Error("no reply")), 8000);
    });
    t.eq(replies.map((r) => r.echo.n), [1, 2]);
    const [p] = await t.event(port.onDisconnect, () => port.postMessage({ exit: true }));
    return `exit lastError=${chrome.runtime.lastError?.message ?? "none"}`;
  }, { timeout: 15000 });

  test("runtime.sendNativeMessage#unknown-host", (t) => t.rejects(chrome.runtime.sendNativeMessage("com.god.missing", {})));

  test("runtime.connectNative#unknown-host", async (t) => {
    const port = chrome.runtime.connectNative("com.god.missing");
    await t.event(port.onDisconnect, null);
    return chrome.runtime.lastError?.message ?? "no lastError";
  });

  test("runtime.onConnectNative", (t) => t.ok(chrome.runtime.onConnectNative?.addListener, "missing"));

  const overridden = async (t, url, title) => {
    const tab = await chrome.tabs.create({ url, active: false });
    await god.waitComplete(tab.id).catch(() => {});
    await t.sleep(400);
    const got = await chrome.tabs.get(tab.id);
    await chrome.tabs.remove(tab.id);
    t.eq(got.title, title);
    return `url=${(got.url || got.pendingUrl).replace(/^[a-z-]+:\/\//, "SCHEME://")}`;
  };

  test("chrome_url_overrides.newtab", (t) => overridden(t, undefined, "God NewTab"));
  test("chrome_url_overrides.history", (t) => overridden(t, "chrome://history", "God History"));
  test("chrome_url_overrides.bookmarks", (t) => overridden(t, "chrome://bookmarks", "God Bookmarks"));

  test("externally_connectable#from-web-page", async (t, c) => {
    const tab = await god.openTab(t, `${c.site}/web.html`);
    let results = null;
    for (let i = 0; i < 40 && !results; i++) {
      await t.sleep(250);
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: () => window.GOD_WEB_RESULTS ?? null });
      results = r.result;
    }
    await chrome.tabs.remove(tab.id);
    t.ok(results, "web page tests never finished");
    godContextResults.web = results.map((r) => ({ ...r, ctx: "web" }));
    return `ran ${results.length}`;
  }, { timeout: 15000 });
})();
