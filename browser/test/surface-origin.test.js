const assert = require("node:assert/strict");
const { test } = require("node:test");

const { popupWindowHeading, sidePanelOrigin, webLocation } = require("../dist/ui/surface-origin.js");

const ID = "abcdefghijklmnopabcdefghijklmnop";
const OTHER = "otherotherotherotherotherotherot";
const web = (before, domain, after) => ({ kind: "web", location: { before, domain, after } });
const text = (value) => ({ kind: "text", text: value });

test("a web address is split around its registrable domain", () => {
  assert.deepEqual(webLocation("https://accounts.google.com/signin?x=1", true), { before: "accounts.", domain: "google.com", after: "/signin?x=1" });
  assert.deepEqual(webLocation("https://a.b.example.co.uk/", false), { before: "a.b.", domain: "example.co.uk", after: "" });
  assert.deepEqual(webLocation("https://alice.github.io/x", false), { before: "", domain: "alice.github.io", after: "" });
  assert.deepEqual(webLocation("http://127.0.0.1:8931/fake-signin.html", true), { before: "", domain: "127.0.0.1", after: ":8931/fake-signin.html" });
  assert.deepEqual(webLocation("http://localhost:3000/", true), { before: "", domain: "localhost", after: ":3000" });
  assert.deepEqual(webLocation("https://[::1]:8443/a", false), { before: "", domain: "[::1]", after: ":8443" });
  assert.equal(webLocation(`chrome-extension://${ID}/panel.html`, true), null);
  assert.equal(webLocation("data:text/html,hi", true), null);
  assert.equal(webLocation("not a url", true), null);
});

test("credentials in a web address can't stand in for its host", () => {
  assert.deepEqual(webLocation("https://accounts.google.com@evil.example/signin", false), { before: "", domain: "evil.example", after: "" });
  assert.deepEqual(webLocation("https://accounts.google.com.evil.example/", false), { before: "accounts.google.com.", domain: "evil.example", after: "" });
});

test("the side panel names where a web page comes from, and nothing for the extension's own pages", () => {
  assert.equal(sidePanelOrigin(`chrome-extension://${ID}/panel.html`, ID), null);
  assert.equal(sidePanelOrigin("about:blank", ID), null);
  assert.equal(sidePanelOrigin("", ID), null);
  assert.deepEqual(sidePanelOrigin("https://docs.example.com/guide/start?q=1", ID), web("docs.", "example.com", ""));
  assert.deepEqual(sidePanelOrigin("http://example.test:8080/x", ID), web("", "example.test", ":8080"));
  assert.deepEqual(sidePanelOrigin(`chrome-extension://${OTHER}/x.html`, ID), text(`chrome-extension://${OTHER}/x.html`));
});

test("a popup window shows a web page's address instead of the title the page chose", () => {
  const created = { extensionId: ID, extensionName: "Origin Check", showsLocation: false };
  assert.deepEqual(popupWindowHeading("https://evil.example/fake-signin", "Sign in – Google Accounts", created), web("", "evil.example", "/fake-signin"));
  assert.deepEqual(popupWindowHeading(`chrome-extension://${ID}/window.html`, "Settings", created), text("Settings"));
  assert.deepEqual(popupWindowHeading("about:blank", "", created), text(""));
  assert.deepEqual(popupWindowHeading(`chrome-extension://${OTHER}/x.html`, "x", created), text(`chrome-extension://${OTHER}/x.html`));
});

test("an auth popup shows the address, or the extension's name on its own pages", () => {
  const auth = { extensionId: ID, extensionName: "Origin Check", showsLocation: true };
  assert.deepEqual(popupWindowHeading("https://evil.example/fake-signin?x=1", "Sign in", auth), web("", "evil.example", "/fake-signin?x=1"));
  assert.deepEqual(popupWindowHeading("http://127.0.0.1:8931/fake-signin.html", "", auth), web("", "127.0.0.1", ":8931/fake-signin.html"));
  assert.deepEqual(popupWindowHeading(`chrome-extension://${ID}/done.html`, "Done", auth), text("Origin Check"));
  assert.deepEqual(popupWindowHeading("about:blank", "", auth), text("about:blank"));
  assert.deepEqual(popupWindowHeading(`chrome-extension://${OTHER}/x.html`, "", auth), text(`chrome-extension://${OTHER}/x.html`));
});
