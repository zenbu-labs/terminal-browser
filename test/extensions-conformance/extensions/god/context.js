import "./t.js";
import "./surface.js";
import "./tests/core.js";
import "./tests/tabs.js";
import "./tests/platform.js";
import "./tests/contexts.js";

const ctx = document.body.dataset.context;
globalThis.SURFACE = godSurface();

if (ctx === "offscreen") {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.kind !== "offscreen-parse") return;
    const doc = new DOMParser().parseFromString(message.html, "text/html");
    sendResponse({ text: doc.body.textContent });
  });
}

// DevTools opens for every tab; only the one inspecting the test page runs the checks.
async function inspectingTestPage() {
  const href = await new Promise((r) => chrome.devtools.inspectedWindow.eval("location.href", (res) => r(res)));
  return typeof href === "string" && href.startsWith("http://localhost") && href.includes("/page.html");
}

async function main() {
  if (ctx === "devtools" && !(await inspectingTestPage())) return;
  const config = await chrome.runtime.sendMessage({ kind: "config" });
  const results = await god.run(ctx, config);
  document.body.dataset.done = "1";
  await chrome.runtime.sendMessage({ kind: "results", ctx, results }).catch(() => {});
}

if (ctx !== "page" || !location.search.includes("manual")) main();
