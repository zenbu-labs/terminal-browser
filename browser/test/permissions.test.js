const assert = require("node:assert/strict");
const Module = require("node:module");
const { test } = require("node:test");

// permissions.js stores decisions through shared's sqlite store; keep them in memory instead.
const stored = new Map();
const key = (origin, embedder, kind) => `${origin} ${embedder} ${kind}`;
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request !== "shared") return load.call(this, request, ...rest);
  return {
    sitePermission: (origin, embedder, kind) => stored.get(key(origin, embedder, kind)) ?? null,
    setSitePermission: ({ origin, embedder, kind, allowed }) =>
      stored.set(key(origin, embedder, kind), allowed),
  };
};

const { PROMPT_ARMING_MS, PermissionPrompts } = require("../dist/session/permissions.js");
const { permitExternalLaunch } = require("../dist/browsing/external-protocol.js");

function prompts() {
  stored.clear();
  return new PermissionPrompts({ requestRender: () => {}, deviceAccess: async () => true });
}

function ask(permission, overrides = {}) {
  return {
    permission,
    origin: "https://site.example",
    embedder: "https://site.example",
    mediaTypes: [],
    externalURL: null,
    signal: new AbortController().signal,
    ...overrides,
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

let now = 1_000_000;
Date.now = () => now;

// The user sees the prompt, waits a moment, and clicks Allow.
function allow(permissions, tabId) {
  permissions.view(tabId);
  now += PROMPT_ARMING_MS;
  permissions.decide(tabId, "allow");
}

test("an undecided permission reads as prompt, then as the user's answer", async () => {
  const permissions = prompts();
  assert.equal(permissions.check(ask("notifications")), "prompt");
  const answer = permissions.request(1, ask("notifications"));
  await tick();
  allow(permissions, 1);
  assert.equal(await answer, true);
  assert.equal(permissions.check(ask("notifications")), true);
  assert.equal(permissions.check(ask("clipboard-read")), "prompt");
});

test("pages without a real origin are asked every time", async () => {
  const permissions = prompts();
  const file = { origin: "null", embedder: "null" };
  const first = permissions.request(1, ask("notifications", file));
  await tick();
  allow(permissions, 1);
  assert.equal(await first, true);
  assert.equal(stored.size, 0);
  assert.equal(permissions.check(ask("notifications", file)), "prompt");
  permissions.request(1, ask("notifications", file));
  await tick();
  assert.equal(permissions.hasPending(1), true);
});

test("opening another app is never remembered and names the link type", async () => {
  const permissions = prompts();
  const zoom = ask("openExternal", { externalURL: "zoommtg://zoom.us/join?confno=1" });
  const answer = permissions.request(1, zoom);
  await tick();
  assert.match(permissions.view(1).items[0].label, /zoommtg:/);
  allow(permissions, 1);
  assert.equal(await answer, true);
  assert.equal(stored.size, 0);
  permitExternalLaunch();
  permissions.request(1, ask("openExternal", { externalURL: "vscode://file/etc/passwd" }));
  await tick();
  assert.equal(permissions.hasPending(1), true);
});

test("opening another app names who asked, and isn't asked as the page when no one can be named", async () => {
  const permissions = prompts();
  permitExternalLaunch();
  for (const origin of ["", "null", "terminal-browser://settings"]) {
    const answer = permissions.request(1, ask("openExternal", { origin, externalURL: "zoommtg://zoom.us/join" }));
    await tick();
    assert.equal(permissions.hasPending(1), false, origin);
    assert.equal(await answer, false, origin);
  }
  permissions.request(1, ask("openExternal", { origin: "https://ads.example", externalURL: "zoommtg://zoom.us/join" }));
  await tick();
  assert.equal(permissions.view(1).host, "ads.example");
  permissions.decide(1, "block");
  permitExternalLaunch();
  permissions.request(1, ask("openExternal", { origin: "file://", externalURL: "zoommtg://zoom.us/join" }));
  await tick();
  assert.equal(permissions.view(1).host, "file://");
});

test("like Chrome, a page gets one request to open another app per user interaction", async () => {
  const permissions = prompts();
  permitExternalLaunch();
  permissions.request(1, ask("openExternal", { externalURL: "zoommtg://zoom.us/join?confno=1" }));
  await tick();
  permissions.decide(1, "block");
  assert.equal(await permissions.request(1, ask("openExternal", { externalURL: "zoommtg://zoom.us/join?confno=2" })), false);
  assert.equal(permissions.hasPending(1), false);
  permitExternalLaunch();
  permissions.request(1, ask("openExternal", { externalURL: "zoommtg://zoom.us/join?confno=3" }));
  await tick();
  assert.equal(permissions.hasPending(1), true);
});

test("schemes Chrome never hands to another app are refused without asking", async () => {
  const permissions = prompts();
  for (const url of ["shell:startup", "FILE:///etc/passwd", "javascript:alert(1)", "vbscript:x", "c:/Windows/notepad.exe", "view-source:https://a.example/", "ms-help://x"]) {
    permitExternalLaunch();
    assert.equal(await permissions.request(1, ask("openExternal", { externalURL: url })), false, url);
    assert.equal(permissions.hasPending(1), false, url);
  }
});

test("Allow only counts once the prompt has been on screen for a moment", async () => {
  const permissions = prompts();
  const answer = permissions.request(1, ask("notifications"));
  await tick();
  permissions.decide(1, "allow");
  assert.equal(permissions.hasPending(1), true, "before the prompt was ever shown");
  permissions.view(1);
  now += PROMPT_ARMING_MS - 1;
  permissions.decide(1, "allow");
  assert.equal(permissions.hasPending(1), true, "right after it showed");
  now += 1;
  permissions.decide(1, "allow");
  assert.equal(await answer, true);
});

test("a cancelled request takes its prompt down", async () => {
  const permissions = prompts();
  const cancel = new AbortController();
  const answer = permissions.request(1, ask("notifications", { signal: cancel.signal }));
  await tick();
  assert.equal(permissions.hasPending(1), true);
  cancel.abort();
  assert.equal(await answer, false);
  assert.equal(permissions.hasPending(1), false);
});

test("a decision is stored for the page the request came from", async () => {
  const permissions = prompts();
  const popup = { origin: "https://evil.example", embedder: "https://evil.example" };
  const answer = permissions.request(1, ask("media", { ...popup, mediaTypes: ["video"] }));
  await tick();
  allow(permissions, 1);
  assert.equal(await answer, true);
  assert.deepEqual([...stored.keys()], ["https://evil.example https://evil.example media:video"]);
});
