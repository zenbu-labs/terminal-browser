const assert = require("node:assert/strict");
const { test } = require("node:test");

require("./fake-electron.js");
const { extensionNavigableUrl } = require("../dist/extensions/api/tabs.js");

const OWN = "a".repeat(32);
const OTHER = "b".repeat(32);

function extension(id, manifest = {}) {
  return { id, baseUrl: `chrome-extension://${id}/`, manifest: { manifest_version: 3, ...manifest } };
}

const own = extension(OWN);
const other = extension(OTHER, { web_accessible_resources: [{ resources: ["open.html"], extension_ids: [OWN] }] });
const service = { get: (id) => ({ [OWN]: own, [OTHER]: other })[id] ?? null };
const navigable = (url) => extensionNavigableUrl(service, own, url);

test("another extension's private page stays out of reach whatever the spelling", () => {
  for (const spelling of [
    `chrome-extension://${OTHER}/secret.html`,
    `CHROME-EXTENSION://${OTHER}/secret.html`,
    `chrome-extension://${OTHER.toUpperCase()}/secret.html`,
    `chrome-extension:\\\\${OTHER}\\secret.html`,
    `chrome-extension:///${OTHER}/secret.html`,
    `\\\\${OTHER}\\secret.html`,
    `//${OTHER}/secret.html`,
    `chrome-ext\tension://${OTHER}/secret.html`,
  ]) {
    assert.throws(() => navigable(spelling), { message: `Cannot navigate to ${spelling}.` }, spelling);
  }
  assert.equal(navigable(`CHROME-EXTENSION://${OTHER}/open.html`), `chrome-extension://${OTHER}/open.html`);
  assert.equal(navigable("page.html"), `chrome-extension://${OWN}/page.html`);
  assert.equal(navigable(`chrome-extension:${OTHER}/x.html`), `chrome-extension://${OWN}/${OTHER}/x.html`);
});

test("blocked schemes are refused whatever the spelling", () => {
  for (const spelling of ["DEVTOOLS://devtools/x", " javascript:1", "FILE:///etc/passwd", "View-Source:https://a.test", "chrome-untrusted:\\\\x"]) {
    assert.throws(() => navigable(spelling), /Cannot navigate to|JavaScript URLs are not allowed/, spelling);
  }
});
