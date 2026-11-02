const GOD = "hgiikgalddcijbhlkbmbemmpbohkocaj";

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  switch (message?.kind) {
    case "ping":
      sendResponse({ pong: true, sender });
      return;
    case "message-god-back":
      chrome.runtime.sendMessage(GOD, { kind: "hello-from-peer" }).then((god) => sendResponse({ god }), (e) => sendResponse({ error: e.message }));
      return true;
    case "connect-god-back": {
      const port = chrome.runtime.connect(GOD, { name: "peer-port" });
      port.onMessage.addListener((god) => {
        sendResponse({ god });
        port.disconnect();
      });
      port.onDisconnect.addListener(() => sendResponse({ error: chrome.runtime.lastError?.message ?? "disconnected" }));
      port.postMessage({ from: "peer" });
      return true;
    }
    case "fetch-war":
      Promise.all(message.urls.map((u) => fetch(u).then((r) => r.text()).then((t) => t.trim(), (e) => "error: " + e.message))).then(sendResponse);
      return true;
  }
});

chrome.runtime.onConnectExternal.addListener((port) => {
  port.onMessage.addListener((m) => port.postMessage({ pong: m.ping, name: port.name }));
});
