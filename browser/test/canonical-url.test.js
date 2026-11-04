const assert = require("node:assert/strict");
const { test } = require("node:test");

const { canonicalOrigin, canonicalUrl, extensionIdOfUrl } = require("../dist/canonical-url.js");

const ID = "b".repeat(32);
const OWN = "a".repeat(32);

test("extension URLs are read the way Chromium reads them, whatever the spelling", () => {
  for (const spelling of [
    `chrome-extension://${ID}/`,
    `CHROME-EXTENSION://${ID}/`,
    `Chrome-Extension://${ID.toUpperCase()}/`,
    `chrome-extension:\\\\${ID}\\`,
    `chrome-extension:${ID}/`,
    `chrome-extension:///${ID}/`,
    ` \tchrome-extension://${ID}/ `,
    `chrome-ext\tension://${ID}/`,
    `chrome-extension://%${ID.charCodeAt(0).toString(16)}${ID.slice(1)}/`,
    `blob:chrome-extension://${ID}/0b4d`,
    `filesystem:CHROME-EXTENSION://${ID}/temporary/x`,
  ]) {
    assert.equal(canonicalOrigin(spelling), `chrome-extension://${ID}`, spelling);
  }
  assert.equal(extensionIdOfUrl(`CHROME-EXTENSION:\\\\${ID}\\page.html`), ID);
  assert.equal(canonicalUrl(`CHROME-EXTENSION:\\\\${ID}\\page.html?q#h`).href, `chrome-extension://${ID}/page.html?q#h`);
});

test("relative URLs resolve against an extension base like Chromium resolves them", () => {
  const base = `chrome-extension://${OWN}/dir/page.html`;
  assert.equal(canonicalUrl("other.html", base).href, `chrome-extension://${OWN}/dir/other.html`);
  assert.equal(canonicalUrl("/top.html", base).href, `chrome-extension://${OWN}/top.html`);
  assert.equal(canonicalUrl(`//${ID}/x.html`, base).href, `chrome-extension://${ID}/x.html`);
  assert.equal(canonicalUrl(`\\\\${ID}\\x.html`, base).href, `chrome-extension://${ID}/x.html`);
  assert.equal(canonicalUrl("chrome-extension:x.html", base).href, `chrome-extension://${OWN}/dir/x.html`);
  assert.equal(canonicalUrl("https://a.test/p", base).href, "https://a.test/p");
  assert.equal(canonicalUrl("chrome-extension:foo", "https://a.test/").href, "chrome-extension://foo/");
});

test("internal pages lowercase their host like Chromium", () => {
  assert.deepEqual(
    { scheme: canonicalUrl("TERMINAL-BROWSER://EXTENSIONS/import").scheme, href: canonicalUrl("TERMINAL-BROWSER://EXTENSIONS/import").href },
    { scheme: "terminal-browser", href: "terminal-browser://extensions/import" },
  );
  assert.equal(canonicalUrl("terminal-browser://extensions").href, "terminal-browser://extensions/");
  assert.equal(canonicalUrl("terminal-browser:\\\\settings").host, "settings");
});

test("web URLs keep the WHATWG reading, and URLs Chromium rejects give nothing", () => {
  assert.equal(canonicalOrigin("HTTPS://A.Test:443/x"), "https://a.test");
  assert.equal(canonicalOrigin("https://chromewebstore.google.com@evil.test/"), "https://evil.test");
  assert.equal(canonicalOrigin("file:///etc/passwd"), "file://");
  assert.equal(canonicalOrigin("data:text/plain,x"), null);
  assert.equal(canonicalOrigin("not a url"), null);
  assert.equal(canonicalOrigin(`chrome-extension://${ID}:80/`), null);
  assert.equal(canonicalOrigin(`chrome-extension://${ID}:443/`), null);
  assert.equal(canonicalOrigin(`chrome-extension://user@${ID}/`), null);
  assert.equal(canonicalOrigin("chrome-extension://"), null);
  assert.equal(extensionIdOfUrl("chrome-extension://not-an-id/"), null);
  assert.equal(extensionIdOfUrl(`https://${ID}/`), null);
});
