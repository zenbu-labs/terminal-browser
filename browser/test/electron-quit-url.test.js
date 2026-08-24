const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

function electronCommand() {
  const electronRoot = path.dirname(require.resolve("electron/package.json"));
  if (process.platform === "darwin") {
    return [path.join(electronRoot, "dist", "Electron.app", "Contents", "MacOS", "Electron")];
  }
  return ["xvfb-run", "-a", path.join(electronRoot, "dist", "electron"), "--no-sandbox"];
}

test("Electron serialization feeds the production quit URL policy", () => {
  const [command, ...prefix] = electronCommand();
  const fixture = path.join(__dirname, "electron-quit-url-fixture.js");
  const result = spawnSync(command, [...prefix, fixture], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout.trim().split("\n").at(-1));

  assert.deepEqual(output.defaultUpperNavigation, {
    rawUrl: "Terminal-browser://quit",
    eventUrl: "terminal-browser://quit",
    request: "navigation",
    action: "consume",
    closeAttempts: 0,
  });
  assert.deepEqual(output.defaultUpperWindowOpen, {
    rawUrl: "Terminal-browser://quit",
    eventUrl: "terminal-browser://quit",
    request: "window-open",
    action: "consume",
    closeAttempts: 0,
  });
  assert.deepEqual(output.optInUpperNavigation, {
    rawUrl: "Terminal-browser://quit",
    eventUrl: "terminal-browser://quit",
    request: "navigation",
    action: "close",
    closeAttempts: 1,
  });
  assert.deepEqual(output.optInUpperWindowOpen, {
    rawUrl: "Terminal-browser://quit",
    eventUrl: "terminal-browser://quit",
    request: "window-open",
    action: "close",
    closeAttempts: 1,
  });

  const rejectedVariants = {
    hostCase: "terminal-browser://QUIT",
    encodedHost: "terminal-browser://qu%69t",
    slash: "terminal-browser://quit/",
    path: "terminal-browser://quit/path",
    query: "terminal-browser://quit?now",
    fragment: "terminal-browser://quit#now",
  };
  for (const [name, eventUrl] of Object.entries(rejectedVariants)) {
    assert.equal(output.variants[name].eventUrl, eventUrl);
    assert.equal(output.variants[name].action, "ignore");
    assert.equal(output.variants[name].closeAttempts, 0);
  }

  for (const name of [
    "popupNavigation",
    "popupWindowOpen",
    "nestedPopupNavigation",
    "nestedPopupWindowOpen",
    "foreignNavigation",
    "otherSessionNavigation",
  ]) {
    assert.equal(output[name].eventUrl, "terminal-browser://quit", name);
    assert.equal(output[name].action, "consume", name);
    assert.equal(output[name].closeAttempts, 0, name);
  }
  assert.equal(output.redirect.eventUrl, "terminal-browser://quit");
  assert.equal(output.redirect.request, "redirect");
  assert.equal(output.redirect.action, "consume");
  assert.equal(output.redirect.closeAttempts, 0);

  for (const [group, cases] of Object.entries({
    crossOriginPopup: output.crossOriginPopup,
    sameOriginPopup: output.sameOriginPopup,
    nestedPopup: output.nestedPopup,
  })) {
    for (const [name, result] of Object.entries(cases)) {
      assert.equal(result.eventUrl, "terminal-browser://quit", `${group}.${name}`);
      assert.equal(result.targetContentsId, result.ownerContentsId, `${group}.${name}`);
      assert.equal(result.initiatorContentsId, result.sourceContentsId, `${group}.${name}`);
      assert.notEqual(result.initiatorContentsId, result.ownerContentsId, `${group}.${name}`);
      assert.equal(result.action, "consume", `${group}.${name}`);
      assert.equal(result.closeAttempts, 0, `${group}.${name}`);
    }
  }

  for (const name of ["navigationDefault", "windowOpenDefault"]) {
    assert.equal(output.ownerRealm[name].action, "consume", name);
    assert.equal(output.ownerRealm[name].closeAttempts, 0, name);
  }
  for (const name of ["navigationOptIn", "windowOpenOptIn"]) {
    const result = output.ownerRealm[name];
    assert.equal(result.action, "close", name);
    assert.equal(result.closeAttempts, 1, name);
    assert.equal(result.targetContentsId, result.ownerContentsId, name);
    if (result.request === "navigation") {
      assert.equal(result.initiatorContentsId, result.ownerContentsId, name);
    }
  }
});
