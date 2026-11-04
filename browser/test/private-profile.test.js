const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-private-profile-data-"));
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-private-profile-config-"));
const electron = require("./fake-electron.js");
const userData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tb-private-profile-user-")));
electron.app.getPath = () => userData;

const { SettingStore } = require("../dist/extensions/setting-store.js");
const { ContentSettingsStore } = require("../dist/extensions/content-settings.js");
const { DeclarativeContentStore } = require("../dist/extensions/api/declarative-content.js");

const A = "a".repeat(32);

function mode(file) {
  return (fs.lstatSync(file).mode & 0o777).toString(8);
}

function withUmask(mask, run) {
  const previous = process.umask(mask);
  try {
    return run();
  } finally {
    process.umask(previous);
  }
}

test("extension settings, content settings and declarativeContent rules are written 0600 in 0700 folders under umask 000", () => {
  withUmask(0o000, () => {
    const settings = new SettingStore(path.join(userData, "extension-settings.json"));
    settings.define("flag", { base: () => false, controllable: true });
    settings.setActive(new Map([[A, 1]]));
    settings.set(A, "flag", true);

    const host = { onUnload() {}, onUninstall() {}, onChange() {} };
    new ContentSettingsStore(host).set(A, "cookies", { scheme: "https", host: "example.com" }, null, "block");

    const service = {
      onUnload() {},
      onUninstall() {},
      onActivate() {},
      allTabs: () => [],
      actions: { clearDeclarative() {} },
    };
    const extension = { id: A, hasApiPermission: () => true };
    new DeclarativeContentStore(service).add(extension, [
      { conditions: [{ instanceType: "declarativeContent.PageStateMatcher", pageUrl: { hostEquals: "example.com" } }], actions: [{ instanceType: "declarativeContent.ShowAction" }] },
    ]);
  });
  assert.equal(mode(path.join(userData, "extension-settings.json")), "600");
  for (const folder of ["extension-content-settings", "extension-content-rules"]) {
    assert.equal(mode(path.join(userData, folder)), "700", folder);
    assert.equal(mode(path.join(userData, folder, `${A}.json`)), "600", folder);
  }
});

test("the Electron profile folder and the JSON an older version left in it are tightened when claimed", () => {
  const appData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tb-private-profile-appdata-")));
  process.env.TERMINAL_BROWSER_APPDATA = appData;
  const { APP_DIR_NAME } = require("shared");
  const dir = path.join(appData, APP_DIR_NAME);
  const files = [
    path.join(dir, "extension-settings.json"),
    path.join(dir, "extension-content-settings", `${A}.json`),
    path.join(dir, "extension-content-rules", `${A}.json`),
  ];
  for (const file of files) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}");
  }
  for (const folder of [dir, ...files.slice(1).map((file) => path.dirname(file))]) fs.chmodSync(folder, 0o755);
  for (const file of files) fs.chmodSync(file, 0o644);
  let claimed = null;
  electron.app.setPath = (_name, value) => (claimed = value);
  require("../dist/profile.js").claimProfile();
  assert.equal(claimed, dir);
  assert.equal(mode(dir), "700");
  for (const file of files) {
    assert.equal(mode(path.dirname(file)), "700", file);
    assert.equal(mode(file), "600", file);
  }
  assert.equal(mode(path.join(dir, "terminal-browser.lock")), "600");
});

test("a profile folder that is a symbolic link is refused instead of swapped for a fresh one", () => {
  const appData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tb-private-profile-linked-")));
  process.env.TERMINAL_BROWSER_APPDATA = appData;
  const { APP_DIR_NAME } = require("shared");
  const elsewhere = path.join(appData, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.chmodSync(elsewhere, 0o755);
  fs.symlinkSync(elsewhere, path.join(appData, APP_DIR_NAME));
  electron.app.setPath = () => assert.fail("a profile was claimed");
  assert.throws(() => require("../dist/profile.js").claimProfile(), /Refusing to use .*: it is a symbolic link/);
  assert.equal(mode(elsewhere), "755");
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});
