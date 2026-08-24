const assert = require("node:assert/strict");
const { test } = require("node:test");

const { TabManager } = require("../dist/session/tabs");

function manager() {
  const host = {
    createController(url, _visible, onState) {
      return {
        devtools: null,
        focusContent() {},
        setVisible() {},
        state: { url },
        stop() {},
        targetId: async () => null,
        onClosed: null,
        onContextMenu: null,
        onCursorChange: null,
        onDevtoolsAction: null,
        onDevtoolsChange: null,
        onOpenTab: null,
        onPopupChange: null,
      };
    },
    onActivated() {},
    onActiveState() {},
    onCursorChanged() {},
    onDevtoolsAction() {},
    onDevtoolsChanged() {},
    onPageMenu() {},
    onTabClosed() {},
    onTabOpened() {},
    onTabsChanged() {},
    requestRender() {},
    tabSwitchAllowed: () => true,
  };
  return new TabManager(host, "about:blank");
}

test("cycles, duplicates, and reopens tabs", () => {
  const tabs = manager();
  const first = tabs.create("https://one.example");
  const second = tabs.create("https://two.example");
  assert.equal(tabs.active.id, second.id);
  assert.equal(tabs.cycle(-1), true);
  assert.equal(tabs.active.id, first.id);
  assert.equal(tabs.duplicateActive(), true);
  assert.equal(tabs.activeState.url, "https://one.example");
  const duplicate = tabs.active.id;
  tabs.close(duplicate);
  assert.equal(tabs.canReopen, true);
  assert.equal(tabs.reopenClosed(), true);
  assert.equal(tabs.activeState.url, "https://one.example");
});
