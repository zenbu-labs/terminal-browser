const assert = require("node:assert/strict");
const { test } = require("node:test");

const { stubModule } = require("./stub-modules.js");

const app = { name: "terminal-browser", userAgentFallback: "", getName: () => app.name };
stubModule("electron", { app });

const MODULE = require.resolve("../dist/user-agent.js");

/**
 * The presented string is computed once per process, so each case re-requires the module with a
 * different fallback. That is also what makes the memoisation itself testable.
 */
function present(userAgent, name) {
  app.userAgentFallback = userAgent;
  app.name = name;
  delete require.cache[MODULE];
  return require(MODULE);
}

const CHROMIUM =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

test("the Electron and app products are dropped and nothing else moves", () => {
  const { browserUserAgent } = present(
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) terminal-browser/0.1.0 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36`,
    "terminal-browser",
  );
  // Google refuses OAuth from either token, and Chrome/Safari/AppleWebKit have to survive intact.
  assert.equal(browserUserAgent(), CHROMIUM);
});

test("the app name is matched with spaces and case ignored", () => {
  const { browserUserAgent } = present(
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 TerminalBrowser/0.1.0 Electron/33.0.0 Safari/537.36`,
    "Terminal Browser",
  );
  assert.equal(browserUserAgent(), CHROMIUM);
});

test("a product token with no version is dropped too", () => {
  const { browserUserAgent } = present("Chrome/130.0.0.0 Electron terminal-browser Safari/537.36", "terminal-browser");
  assert.equal(browserUserAgent(), "Chrome/130.0.0.0 Safari/537.36");
});

test("a product that merely starts with the same letters is kept", () => {
  // Matching on a prefix or a substring would strip these, and every one of them is somebody's
  // real user-agent token.
  const { browserUserAgent } = present(
    "Chrome/130.0.0.0 ElectronicArts/1.0 Electronic/2.0 terminal-browser-helper/1.0 Safari/537.36",
    "terminal-browser",
  );
  assert.equal(
    browserUserAgent(),
    "Chrome/130.0.0.0 ElectronicArts/1.0 Electronic/2.0 terminal-browser-helper/1.0 Safari/537.36",
  );
});

test("applying the policy writes the stripped string back to electron", () => {
  const { applyUserAgentPolicy, browserUserAgent } = present(
    "Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36",
    "terminal-browser",
  );
  applyUserAgentPolicy();
  assert.equal(app.userAgentFallback, "Chrome/130.0.0.0 Safari/537.36");
  // Idempotent: reapplying must not keep chewing on its own output.
  applyUserAgentPolicy();
  assert.equal(app.userAgentFallback, "Chrome/130.0.0.0 Safari/537.36");
  assert.equal(browserUserAgent(), "Chrome/130.0.0.0 Safari/537.36");
});

test("the string is computed once, so every window presents the same one", () => {
  const { browserUserAgent } = present("Chrome/130.0.0.0 Electron/33.0.0", "terminal-browser");
  const first = browserUserAgent();
  app.userAgentFallback = "Chrome/999.0.0.0 Electron/99.0.0";
  assert.equal(browserUserAgent(), first);
});
