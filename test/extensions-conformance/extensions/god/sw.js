import "./t.js";
import "./surface.js";
import "./tests/core.js";
import "./tests/tabs.js";
import "./tests/data.js";
import "./tests/ui.js";
import "./tests/net.js";
import "./tests/platform.js";
import "./tests/external.js";

globalThis.SURFACE = godSurface();
globalThis.godInstalled = [];
globalThis.godStartup = [];
chrome.runtime.onInstalled.addListener((details) => godInstalled.push(details));
chrome.runtime.onStartup.addListener(() => godStartup.push(Date.now()));

// Events only a person (or the harness acting as one) can trigger are recorded
// here; the harness reads godEvents after triggering them.
const events = (globalThis.godEvents = {});
const clean = (value) => JSON.parse(JSON.stringify(value ?? null));
function record(name, extra) {
  return (...args) => {
    (events[name] ??= []).push(clean(args.filter((a) => typeof a !== "function")));
    return extra?.(...args);
  };
}
const add = (path, listener) => {
  const evt = path.split(".").reduce((o, k) => o?.[k], chrome);
  if (evt?.addListener) evt.addListener(listener);
};
add("commands.onCommand", record("commands.onCommand"));
add("action.onClicked", record("action.onClicked"));
add("contextMenus.onClicked", record("contextMenus.onClicked"));
add("omnibox.onInputStarted", record("omnibox.onInputStarted"));
add("omnibox.onInputChanged", record("omnibox.onInputChanged", (text, suggest) => {
  suggest([{ content: `god-${text}`, description: `God suggestion <match>${text}</match>`, deletable: true }]);
}));
add("omnibox.onInputEntered", record("omnibox.onInputEntered"));
add("omnibox.onInputCancelled", record("omnibox.onInputCancelled"));
add("omnibox.onDeleteSuggestion", record("omnibox.onDeleteSuggestion"));
add("notifications.onClicked", record("notifications.onClicked"));
add("notifications.onButtonClicked", record("notifications.onButtonClicked"));
add("sidePanel.onOpened", record("sidePanel.onOpened"));
add("sidePanel.onClosed", record("sidePanel.onClosed"));
add("permissions.onAdded", record("permissions.onAdded"));
add("permissions.onRemoved", record("permissions.onRemoved"));
add("runtime.onMessageExternal", record("runtime.onMessageExternal", (message, sender, sendResponse) => {
  sendResponse({ god: "external-reply", got: message, sender });
}));
add("runtime.onConnectExternal", record("runtime.onConnectExternal", (port) => {
  port.onMessage.addListener((m) => port.postMessage({ god: "external-port-reply", got: m, sender: port.sender }));
}));
add("tabs.onReplaced", record("tabs.onReplaced"));
add("webNavigation.onCreatedNavigationTarget", record("webNavigation.onCreatedNavigationTarget"));

const contextResults = (globalThis.godContextResults = {});
const resultPorts = new Set();
const allResults = () => [...god.results, ...Object.values(contextResults).flat()];
function broadcast(result) {
  for (const port of resultPorts) port.postMessage({ result });
}
god.onResult(broadcast);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.kind) {
    case "echo":
      sendResponse({ echo: message.value, sender });
      return;
    case "echo-async":
      setTimeout(() => sendResponse({ echo: message.value }), 100);
      return true;
    case "echo-promise":
      return Promise.resolve({ echo: message.value });
    case "config":
      sendResponse(god.config);
      return;
    case "results":
      contextResults[message.ctx] = message.results;
      message.results.forEach(broadcast);
      sendResponse(true);
      return;
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "god-results") {
    resultPorts.add(port);
    port.onDisconnect.addListener(() => resultPorts.delete(port));
    port.postMessage({ all: allResults(), config: god.config });
    return;
  }
  if (port.name === "god-disconnect-me") {
    port.onMessage.addListener(() => port.disconnect());
    return;
  }
  port.onMessage.addListener((m) => port.postMessage({ pong: m.ping, name: port.name, sender: port.sender }));
});

globalThis.godAll = allResults;
