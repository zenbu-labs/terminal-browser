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

const { PermissionPrompts } = require("../dist/session/permissions.js");

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

test("an undecided permission reads as prompt, then as the user's answer", async () => {
  const permissions = prompts();
  assert.equal(permissions.check(ask("notifications")), "prompt");
  const answer = permissions.request(1, ask("notifications"));
  await tick();
  permissions.decide(1, "allow");
  assert.equal(await answer, true);
  assert.equal(permissions.check(ask("notifications")), true);
  assert.equal(permissions.check(ask("clipboard-read")), "prompt");
});

test("pages without a real origin are asked every time", async () => {
  const permissions = prompts();
  const file = { origin: "null", embedder: "null" };
  const first = permissions.request(1, ask("notifications", file));
  await tick();
  permissions.decide(1, "allow");
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
  permissions.decide(1, "allow");
  assert.equal(await answer, true);
  assert.equal(stored.size, 0);
  permissions.request(1, ask("openExternal", { externalURL: "vscode://file/etc/passwd" }));
  await tick();
  assert.equal(permissions.hasPending(1), true);
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
  permissions.decide(1, "allow");
  assert.equal(await answer, true);
  assert.deepEqual([...stored.keys()], ["https://evil.example https://evil.example media:video"]);
});
