document.documentElement.dataset.godCs = JSON.stringify(godSurface());

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.kind !== "cs-echo") return;
  sendResponse({ echo: message.value, where: "cs", frameId: window === top ? 0 : "child", senderId: sender.id, senderKeys: Object.keys(sender).sort().join(",") });
});

chrome.runtime.onConnect.addListener((port) => {
  port.onMessage.addListener((m) => port.postMessage({ pong: m.ping, senderKeys: Object.keys(port.sender ?? {}).sort().join(",") }));
});

if (window === top && new URLSearchParams(location.search).has("cs-tests")) {
  (async () => {
    const config = await chrome.runtime.sendMessage({ kind: "config" });
    const results = await god.run("cs", config);
    document.documentElement.dataset.godCsResults = JSON.stringify(results);
    await chrome.runtime.sendMessage({ kind: "results", ctx: "cs", results });
  })();
}
