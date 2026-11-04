const assert = require("node:assert/strict");
const { test } = require("node:test");

const { AuthPrompts } = require("../dist/session/auth.js");
const { PROMPT_ARMING_MS } = require("../dist/session/permissions.js");
const { applyMaskedEdit, masked } = require("../dist/ui/masked-text.js");

const bytes = (text) => Buffer.byteLength(text);
const settle = () => new Promise((resolve) => setImmediate(resolve));

function prompts() {
  const left = [];
  const finishLeaving = [];
  const auth = new AuthPrompts({
    requestRender() {},
    leaveUnsafePage: (id, done) => {
      left.push(id);
      finishLeaving.push(done);
    },
  });
  return { auth, left, finishLeaving };
}

function login(overrides = {}) {
  return {
    url: "https://site.example/private",
    host: "site.example",
    port: 443,
    realm: "r",
    scheme: "basic",
    isProxy: false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function certificateError(signal = new AbortController().signal) {
  return {
    url: "https://self-signed.example/",
    host: "self-signed.example",
    error: "net::ERR_CERT_AUTHORITY_INVALID",
    certificate: { subject: "s", issuer: "i", validExpiry: 0, fingerprint: "sha256/x" },
    signal,
  };
}

function clock(t) {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  return (ms) => (now += ms);
}

test("typing, pasting and deleting in a masked field keep the real password", () => {
  let real = "";
  const type = (shown, cursorChars) => {
    real = applyMaskedEdit(real, shown, bytes([...shown].slice(0, cursorChars).join("")));
  };
  type("p", 1);
  type(`${masked("p")}a`, 2);
  type(`${masked("pa")}$$`, 4);
  assert.equal(real, "pa$$");
  type(`${masked("pa$")}`, 3);
  assert.equal(real, "pa$");
  type(`•Xé•`, 3);
  assert.equal(real, "pXé$");
  type("new", 3);
  assert.equal(real, "new");
});

test("deleting forward or backward from the middle removes the right character", () => {
  assert.equal(applyMaskedEdit("abcd", "•••", bytes("••")), "abd");
  assert.equal(applyMaskedEdit("abcd", "•••", bytes("•")), "acd");
  assert.equal(applyMaskedEdit("abcd", "", 0), "");
});

test("a sign in answers with the typed credentials, cancel answers with nothing", async (t) => {
  const advance = clock(t);
  const { auth } = prompts();
  const gate = auth.gate(1);
  const first = gate.login(login());
  assert.equal(auth.view(1).kind, "login");
  advance(PROMPT_ARMING_MS);
  auth.submitLogin(1, { username: "user", password: "pass" });
  assert.deepEqual(await first, { username: "user", password: "pass" });

  const second = gate.login(login());
  auth.view(1);
  auth.cancel(1);
  assert.equal(await second, null);
  assert.equal(auth.hasPending(1), false);
});

test("Enter right as a sign in opens is ignored, but Enter right after typing is not", async (t) => {
  const advance = clock(t);
  const { auth } = prompts();
  let answer;
  auth.gate(1).login(login()).then((value) => (answer = value));
  auth.view(1);
  advance(100);
  auth.submitLogin(1, { username: "u", password: "p" });
  await settle();
  assert.equal(answer, undefined);
  advance(PROMPT_ARMING_MS);
  auth.noteInput();
  auth.submitLogin(1, { username: "u", password: "p" });
  await settle();
  assert.deepEqual(answer, { username: "u", password: "p" });
});

test("Proceed past a certificate error needs the prompt shown and no recent key presses", async (t) => {
  const advance = clock(t);
  const { auth } = prompts();
  let answer;
  auth.gate(1).certificateError(certificateError()).then((value) => (answer = value));
  auth.view(1);
  advance(PROMPT_ARMING_MS);
  auth.accept(1);
  await settle();
  assert.equal(answer, undefined, "Proceed is hidden until Advanced is opened");
  auth.toggleAdvanced(1);
  assert.equal(auth.view(1).advanced, true);
  auth.noteInput();
  auth.accept(1);
  await settle();
  assert.equal(answer, undefined);
  advance(PROMPT_ARMING_MS);
  auth.accept(1);
  await settle();
  assert.equal(answer, true);
});

test("a prompt that was never drawn can't be accepted", async (t) => {
  const advance = clock(t);
  const { auth } = prompts();
  let answer;
  auth.gate(1).certificateError(certificateError()).then((value) => (answer = value));
  auth.toggleAdvanced(1);
  advance(10 * PROMPT_ARMING_MS);
  auth.accept(1);
  await settle();
  assert.equal(answer, undefined);
});

test("Enter on a certificate error goes back instead of proceeding", async (t) => {
  const advance = clock(t);
  const { auth, left } = prompts();
  const answer = auth.gate(4).certificateError(certificateError());
  auth.view(4);
  advance(PROMPT_ARMING_MS);
  auth.enter(4);
  assert.equal(await answer, false);
  assert.deepEqual(left, [4]);
});

test("after Back the warning stays up until the tab is back on the earlier page", async (t) => {
  const advance = clock(t);
  const { auth, finishLeaving } = prompts();
  const answer = auth.gate(2).certificateError(certificateError());
  auth.view(2);
  advance(PROMPT_ARMING_MS);
  auth.cancel(2);
  assert.equal(await answer, false);
  assert.equal(auth.view(2).kind, "certificateError");
  assert.equal(auth.hasPending(2), true);
  finishLeaving[0]();
  assert.equal(auth.view(2), null);
  assert.equal(auth.hasPending(2), false);
});

test("the client certificate picker answers with the picked fingerprint", async (t) => {
  const advance = clock(t);
  const { auth } = prompts();
  const certificates = ["a", "b", "c"].map((name) => ({
    subject: name,
    issuer: "ca",
    validExpiry: 0,
    fingerprint: `sha256/${name}`,
  }));
  const answer = auth
    .gate(1)
    .clientCertificate({ url: "https://mtls.example/", host: "mtls.example", certificates, signal: new AbortController().signal });
  assert.deepEqual(auth.view(1).rows.map((row) => row.label), ["a", "b", "c"]);
  auth.step(1, -1);
  assert.equal(auth.view(1).index, 2);
  auth.pick(1, 1);
  advance(PROMPT_ARMING_MS);
  auth.enter(1);
  assert.equal(await answer, "sha256/b");
});

test("the passkey picker answers with the credential id, and shows names", async (t) => {
  const advance = clock(t);
  const { auth } = prompts();
  const answer = auth.gate(1).passkeyAccount({
    relyingPartyId: "site.example",
    accounts: [
      { credentialId: "c1", name: "ana@site.example", displayName: "Ana" },
      { credentialId: "c2", name: undefined, displayName: undefined },
    ],
    signal: new AbortController().signal,
  });
  assert.deepEqual(auth.view(1).rows, [
    { label: "ana@site.example", detail: "Ana" },
    { label: "c2", detail: "" },
  ]);
  auth.pick(1, 0);
  advance(PROMPT_ARMING_MS);
  auth.accept(1);
  assert.equal(await answer, "c1");
});

test("prompts are per tab, and closing a tab or leaving the page answers them", async () => {
  const { auth } = prompts();
  const leave = new AbortController();
  const fromTwo = auth.gate(2).login(login({ signal: leave.signal }));
  const fromThree = auth.gate(3).certificateError(certificateError());
  assert.equal(auth.hasPending(1), false);
  assert.equal(auth.view(2).kind, "login");
  assert.equal(auth.view(3).kind, "certificateError");
  leave.abort();
  assert.equal(await fromTwo, null);
  auth.closed(3);
  assert.equal(await fromThree, false);
});

test("a proxy sign in names the proxy instead of the page", () => {
  const { auth } = prompts();
  auth.gate(1).login(login({ isProxy: true, host: "proxy.example", port: 3128 }));
  assert.deepEqual(auth.view(1), {
    kind: "login",
    key: auth.view(1).key,
    origin: "proxy.example:3128",
    proxy: true,
    field: "username",
  });
});

test("Tab moves between the username and password fields", () => {
  const { auth } = prompts();
  auth.gate(1).login(login());
  auth.toggleField(1);
  assert.equal(auth.view(1).field, "password");
  auth.toggleField(1);
  assert.equal(auth.view(1).field, "username");
});
