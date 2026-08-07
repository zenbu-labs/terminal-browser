const assert = require("node:assert/strict");
const { test } = require("node:test");

const { computeLayout } = require("../dist/session/layout.js");

/** A pane the size of a real split, at the cell metrics ghostty reports for it. */
const PANE = { width: 736, height: 1734, cellWidth: 15, cellHeight: 33, basePx: 30 };

const layoutFor = (mode, devtools = null) => computeLayout(PANE, 2, mode, devtools);

test("the default keeps a toolbar and insets the page", () => {
  const { chrome } = layoutFor("full");
  assert.equal(chrome.bare, false);
  assert.ok(chrome.toolbarHeight > 0, "expected a toolbar");
  assert.ok(chrome.page.x > 0, "expected the page to be inset from the left");
  assert.ok(chrome.page.width < PANE.width, "expected the page to be narrower than the pane");
});

test("minimal drops the toolbar but keeps the inset", () => {
  const { chrome } = layoutFor("minimal");
  assert.equal(chrome.bare, false);
  assert.equal(chrome.toolbarHeight, 0);
  assert.ok(chrome.page.x > 0, "expected the page to still be inset");
  assert.ok(chrome.page.width < PANE.width);
});

test("chromeless gives the page every pixel of the pane", () => {
  const { chrome, surface } = layoutFor("none");
  assert.equal(chrome.bare, true);
  assert.equal(chrome.toolbarHeight, 0);
  assert.deepEqual(
    { x: chrome.page.x, y: chrome.page.y, width: chrome.page.width, height: chrome.page.height },
    { x: 0, y: 0, width: PANE.width, height: PANE.height },
  );
  assert.equal(surface.width, PANE.width);
  assert.equal(surface.height, PANE.height);
});

test("chromeless still splits for devtools", () => {
  const { chrome } = layoutFor("none", { dock: "bottom", fraction: 0.4 });
  assert.ok(chrome.devtools, "expected a devtools rect");
  assert.equal(chrome.devtools.dock, "bottom");
  assert.ok(chrome.page.height < PANE.height, "expected the page to give up room");
  assert.equal(chrome.devtools.y + chrome.devtools.height, PANE.height);
});

test("a pane shorter than one cell still leaves a usable page", () => {
  for (const mode of ["full", "minimal", "none"]) {
    const tiny = { ...PANE, width: 40, height: 20 };
    const { chrome } = computeLayout(tiny, 2, mode, null);
    assert.ok(chrome.page.width >= 1, `${mode} page width`);
    assert.ok(chrome.page.height >= 1, `${mode} page height`);
  }
});
