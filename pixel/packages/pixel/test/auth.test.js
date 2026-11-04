const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

// auth.js listens on electron's app, which only exists inside the Electron runtime.
const app = new EventEmitter();
app.whenReady = () => Promise.resolve();
app.configureWebAuthn = () => {};
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return { app, webContents: { fromFrame: (frame) => frame.contents } };
  return load.call(this, request, ...rest);
};

const { gatePasskeyAccounts, installAuthHandlers, onAuthFor, webAuthnAccessGroup } = require("../dist/web/auth.js");

installAuthHandlers();

let nextId = 1;
function fakeContents(session = {}) {
  const contents = new EventEmitter();
  contents.id = nextId++;
  contents.session = session;
  return contents;
}

function gate(overrides = {}) {
  return {
    login: async () => null,
    certificateError: async () => false,
    clientCertificate: async () => null,
    passkeyAccount: async () => null,
    ...overrides,
  };
}

function emit(name, ...args) {
  let prevented = false;
  return new Promise((resolve) => {
    app.emit(name, { preventDefault: () => (prevented = true) }, ...args, (...answer) => resolve({ prevented, answer }));
  });
}

const certificate = (fingerprint = "sha256/a") => ({
  subjectName: "self-signed.example",
  issuerName: "self-signed.example",
  validExpiry: 0,
  fingerprint,
});

test("a sign in prompt answers the request with what the user typed", async () => {
  const contents = fakeContents();
  let asked;
  onAuthFor(contents, gate({ login: async (request) => ((asked = request), { username: "u", password: "p" }) }));
  const { prevented, answer } = await emit(
    "login",
    contents,
    { url: "https://site.example/private" },
    { isProxy: false, scheme: "basic", host: "site.example", port: 443, realm: "r" },
  );
  assert.equal(prevented, true);
  assert.deepEqual(answer, ["u", "p"]);
  assert.equal(asked.host, "site.example");
  assert.equal(asked.isProxy, false);
});

test("a sign in with no tab to ask in is cancelled", async () => {
  const { answer } = await emit("login", null, { url: "https://x.example" }, { isProxy: false, scheme: "basic", host: "x.example", port: 443, realm: "" });
  assert.deepEqual(answer, []);
});

test("leaving the page while the sign in prompt is up cancels it", async () => {
  const contents = fakeContents();
  onAuthFor(contents, gate({ login: (request) => new Promise((resolve) => request.signal.addEventListener("abort", () => {})) }));
  const pending = emit("login", contents, { url: "https://site.example" }, { isProxy: false, scheme: "basic", host: "site.example", port: 443, realm: "" });
  contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  assert.deepEqual((await pending).answer, []);
});

test("an invalid certificate is refused for subresources and asked about for the page", async () => {
  const contents = fakeContents({});
  let asks = 0;
  onAuthFor(contents, gate({ certificateError: async () => (asks++, true) }));
  let prevented = false;
  const sub = await new Promise((resolve) => {
    app.emit("certificate-error", { preventDefault: () => (prevented = true) }, contents, "https://bad.example/x.js", "net::ERR_CERT_AUTHORITY_INVALID", certificate(), resolve, false);
  });
  assert.equal(prevented, true);
  assert.equal(sub, false);
  assert.equal(asks, 0);
  const page = await new Promise((resolve) => {
    app.emit("certificate-error", { preventDefault() {} }, contents, "https://bad.example/", "net::ERR_CERT_AUTHORITY_INVALID", certificate(), (allowed) => resolve(allowed), true);
  });
  assert.equal(page, true);
  assert.equal(asks, 1);
});

test("a certificate the user proceeded past is trusted for that session only, and only that exact certificate", async () => {
  const session = {};
  const contents = fakeContents(session);
  let asks = 0;
  onAuthFor(contents, gate({ certificateError: async () => (asks++, true) }));
  const ask = (fingerprint, isMainFrame, on = contents) =>
    new Promise((resolve) => {
      app.emit("certificate-error", { preventDefault() {} }, on, "https://bad.example/", "net::ERR_CERT_DATE_INVALID", certificate(fingerprint), resolve, isMainFrame);
    });
  assert.equal(await ask("sha256/one", true), true);
  assert.equal(await ask("sha256/one", false), true);
  assert.equal(asks, 1);
  assert.equal(await ask("sha256/two", true), true);
  assert.equal(asks, 2);
  const otherProfile = fakeContents({});
  onAuthFor(otherProfile, gate({ certificateError: async () => false }));
  assert.equal(await ask("sha256/one", true, otherProfile), false);
});

test("a certificate decision pending in one session does not answer the same request from another session", async () => {
  const decide = {};
  const first = fakeContents({});
  onAuthFor(first, gate({ certificateError: () => new Promise((resolve) => (decide.first = resolve)) }));
  const second = fakeContents({});
  onAuthFor(second, gate({ certificateError: () => new Promise((resolve) => (decide.second = resolve)) }));
  const ask = (contents) =>
    new Promise((resolve) => {
      app.emit("certificate-error", { preventDefault() {} }, contents, "https://shared.example/", "net::ERR_CERT_AUTHORITY_INVALID", certificate("sha256/shared"), resolve, true);
    });
  const firstAnswer = ask(first);
  const secondAnswer = ask(second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof decide.second, "function");
  decide.first(true);
  assert.equal(await firstAnswer, true);
  const early = await Promise.race([secondAnswer, new Promise((resolve) => setTimeout(() => resolve("unanswered"), 20))]);
  assert.equal(early, "unanswered");
  decide.second(false);
  assert.equal(await secondAnswer, false);
});

test("a client certificate is never picked without asking", async () => {
  const unasked = fakeContents();
  const certificates = [certificate("sha256/a"), certificate("sha256/b")];
  const silent = await emit("select-client-certificate", unasked, "https://mtls.example/", certificates);
  assert.equal(silent.prevented, true);
  assert.deepEqual(silent.answer, []);

  const contents = fakeContents();
  onAuthFor(contents, gate({ clientCertificate: async (request) => request.certificates[1].fingerprint }));
  const picked = await emit("select-client-certificate", contents, "https://mtls.example/", certificates);
  assert.equal(picked.answer[0].fingerprint, "sha256/b");

  let host;
  onAuthFor(contents, gate({ clientCertificate: async (request) => ((host = request.host), null) }));
  await emit("select-client-certificate", contents, "client.badssl.com:443", certificates);
  assert.equal(host, "client.badssl.com");
});

test("the passkey account picker answers with the chosen credential", async () => {
  const session = new EventEmitter();
  gatePasskeyAccounts(session);
  const contents = fakeContents();
  onAuthFor(contents, gate({ passkeyAccount: async (request) => request.accounts[1].credentialId }));
  const answer = await new Promise((resolve) => {
    session.emit(
      "select-webauthn-account",
      { preventDefault() {} },
      { relyingPartyId: "site.example", frame: { contents }, accounts: [{ credentialId: "a" }, { credentialId: "b", name: "b@site.example" }] },
      resolve,
    );
  });
  assert.equal(answer, "b");
});

test("Touch ID is only turned on when the app is signed for a webauthn keychain group", () => {
  const signed = `<?xml version="1.0"?><plist><dict><key>keychain-access-groups</key><array><string>ABCDE12345.com.example.app</string><string>ABCDE12345.com.example.app.webauthn</string></array></dict></plist>`;
  assert.equal(webAuthnAccessGroup(signed), "ABCDE12345.com.example.app.webauthn");
  assert.equal(webAuthnAccessGroup(`<plist><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>`), null);
  assert.equal(webAuthnAccessGroup(""), null);
});

test("a login for a running --ssh proxy is left to the ssh handler, which answers it once", async (t) => {
  const { sshProxyFor, sshProxyLogin } = require("../dist/web/ssh-proxies.js");
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pixel-auth-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const controlPath = path.join(dir, "control");
  fs.writeFileSync(controlPath, "");
  const proxy = await sshProxyFor({ controlPath, destination: "example-host" }, (host, port) => net.connect(port, host), 60_000);
  t.after(() => proxy.close());

  // Stands in for browser-session.ts: answers only the session routed through the proxy.
  const routed = fakeContents();
  const sshHandler = (event, contents, _details, authInfo, callback) => {
    const login = sshProxyLogin(contents === routed ? proxy.port : undefined, authInfo.port);
    if (!authInfo.isProxy || authInfo.host !== "127.0.0.1" || !login) return;
    event.preventDefault();
    callback(login.username, login.password);
  };
  app.on("login", sshHandler);
  t.after(() => app.off("login", sshHandler));

  const login = (contents, port) => {
    const result = { prevented: false, answers: [] };
    app.emit(
      "login",
      { preventDefault: () => (result.prevented = true) },
      contents,
      { url: "https://site.example" },
      { isProxy: true, scheme: "basic", host: "127.0.0.1", port, realm: "" },
      (...answer) => result.answers.push(answer),
    );
    return result;
  };

  onAuthFor(routed, gate({ login: async () => assert.fail("the sign in prompt must not ask for our own ssh proxy") }));
  const ours = login(routed, proxy.port);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ours, { prevented: true, answers: [[proxy.username, proxy.password]] });

  const other = fakeContents();
  onAuthFor(other, gate({ login: async () => ({ username: "u", password: "p" }) }));
  const elsewhere = login(other, proxy.port + 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(elsewhere, { prevented: true, answers: [["u", "p"]] }, "any other proxy is still asked about");
});
