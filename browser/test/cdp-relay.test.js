const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { duplexPair } = require("node:stream");
const { test } = require("node:test");

const { serveCdp } = require("../dist/cdp/server.js");
const { ByteQueue } = require("../dist/cdp/byte-queue.js");

// Stands in for Chromium's end of --remote-debugging-pipe: NUL-separated JSON.
function fakeChromium(end) {
  const seen = [];
  let buffered = "";
  let sessions = 0;
  const send = (message) => end.write(`${JSON.stringify(message)}\0`);
  end.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    let index;
    while ((index = buffered.indexOf("\0")) !== -1) {
      const message = JSON.parse(buffered.slice(0, index));
      buffered = buffered.slice(index + 1);
      seen.push(message);
      const { id, method, sessionId } = message;
      if (method === "Target.attachToBrowserTarget") {
        send({ id, result: { sessionId: `browser-${++sessions}` } });
      } else if (method === "Target.attachToTarget") {
        const child = `page-${++sessions}`;
        send({ method: "Target.attachedToTarget", params: { sessionId: child }, sessionId });
        send({ id, result: { sessionId: child }, sessionId });
      } else if (method === "Test.hold") {
      } else if (method === "Runtime.evaluate") {
        send({ id, result: { result: { value: `ran in ${sessionId}` } }, sessionId });
      } else {
        send({ id, result: {}, ...(sessionId ? { sessionId } : {}) });
      }
    }
  });
  return { seen, send, end };
}

function frame(text) {
  const payload = Buffer.from(text);
  const mask = crypto.randomBytes(4);
  const header = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i & 3]));
  return Buffer.concat([header, mask, masked]);
}

function client(socketPath, headers = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    const messages = [];
    const waiters = [];
    let buffered = Buffer.alloc(0);
    const frames = new ByteQueue();
    let upgraded = false;
    const closed = new Promise((done) => socket.on("close", done));
    const extra = Object.entries(headers).map(([key, value]) => `${key}: ${value}\r\n`).join("");
    socket.on("connect", () => {
      const key = crypto.randomBytes(16).toString("base64");
      socket.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`);
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (!upgraded) resolve({ refused: buffered.toString("latin1") });
      for (const waiter of waiters.splice(0)) waiter(null);
    });
    socket.on("data", (chunk) => {
      if (upgraded) frames.push(chunk);
      else buffered = Buffer.concat([buffered, chunk]);
      if (!upgraded) {
        const end = buffered.indexOf("\r\n\r\n");
        if (end === -1) return;
        const head = buffered.subarray(0, end).toString("latin1");
        if (!head.startsWith("HTTP/1.1 101")) return;
        upgraded = true;
        frames.push(buffered.subarray(end + 4));
        resolve({
          send: (message) => socket.write(frame(JSON.stringify(message))),
          next: () => (messages.length > 0 ? Promise.resolve(messages.shift()) : new Promise((done) => waiters.push(done))),
          close: () => socket.destroy(),
          pause: () => socket.pause(),
          resume: () => socket.resume(),
          closed: () => closed,
        });
      }
      while (upgraded && frames.length >= 2) {
        let length = frames.peek(2)[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (frames.length < 4) return;
          length = frames.peek(4).readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (frames.length < 10) return;
          length = Number(frames.peek(10).readBigUInt64BE(2));
          offset = 10;
        }
        if (frames.length < offset + length) return;
        const opcode = frames.peek(1)[0] & 0x0f;
        frames.take(offset);
        const payload = frames.take(length);
        if (opcode !== 0x1) continue;
        const message = JSON.parse(payload.toString("utf8"));
        if (waiters.length > 0) waiters.shift()(message);
        else messages.push(message);
      }
    });
  });
}

function relay(t, read, limits) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tb-cdp-")));
  const socketPath = path.join(root, "cdp", "cdp.sock");
  const [ours, theirs] = duplexPair();
  const chromium = fakeChromium(theirs);
  const { server, openPort } = serveCdp(ours, socketPath, { read, limits });
  t.after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { socketPath, chromium, server, openPort };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test("the socket is 0600 in a 0700 directory", (t) => {
  const { socketPath } = relay(t);
  assert.equal(fs.lstatSync(socketPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(socketPath)).mode & 0o777, 0o700);
});

test("a client gets its own browser session, and replies keep the client's ids", async (t) => {
  const { socketPath, chromium } = relay(t);
  const cdp = await client(socketPath);
  t.after(() => cdp.close());
  cdp.send({ id: 7, method: "Target.getTargets" });
  assert.deepEqual(await cdp.next(), { id: 7, result: {} });
  const forwarded = chromium.seen.find((message) => message.method === "Target.getTargets");
  assert.equal(forwarded.sessionId, "browser-1");
  assert.notEqual(forwarded.id, 7);
});

test("sessions a client attaches are routed back to it", async (t) => {
  const { socketPath } = relay(t);
  const cdp = await client(socketPath);
  t.after(() => cdp.close());
  cdp.send({ id: 1, method: "Target.attachToTarget", params: { targetId: "T", flatten: true } });
  const attached = await cdp.next();
  assert.equal(attached.method, "Target.attachedToTarget");
  assert.equal(attached.sessionId, undefined);
  const page = attached.params.sessionId;
  assert.deepEqual(await cdp.next(), { id: 1, result: { sessionId: page } });
  cdp.send({ id: 2, method: "Runtime.evaluate", params: { expression: "1" }, sessionId: page });
  assert.deepEqual(await cdp.next(), { id: 2, result: { result: { value: `ran in ${page}` } }, sessionId: page });
});

test("a client cannot use a session that belongs to another client", async (t) => {
  const { socketPath, chromium } = relay(t);
  const owner = await client(socketPath);
  const other = await client(socketPath);
  t.after(() => {
    owner.close();
    other.close();
  });
  owner.send({ id: 1, method: "Target.attachToTarget", params: { targetId: "T", flatten: true } });
  const page = (await owner.next()).params.sessionId;
  await owner.next();
  const before = chromium.seen.length;
  other.send({ id: 9, method: "Runtime.evaluate", params: { expression: "document.cookie" }, sessionId: page });
  const reply = await other.next();
  assert.equal(reply.id, 9);
  assert.equal(reply.error.message, "Session with given id not found.");
  await settle();
  assert.equal(chromium.seen.length, before);
});

test("a closed client's sessions are detached", async (t) => {
  const { socketPath, chromium } = relay(t);
  const cdp = await client(socketPath);
  cdp.send({ id: 1, method: "Target.attachToTarget", params: { targetId: "T", flatten: true } });
  const page = (await cdp.next()).params.sessionId;
  await cdp.next();
  cdp.close();
  await settle();
  const detached = chromium.seen.filter((message) => message.method === "Target.detachFromTarget").map((message) => message.params.sessionId);
  assert.deepEqual(detached.sort(), ["browser-1", page].sort());
});

test("a WebSocket handshake from a web page is refused", async (t) => {
  const { socketPath, chromium } = relay(t);
  const result = await client(socketPath, { Origin: "https://evil.example" });
  assert.match(result.refused, /^HTTP\/1.1 403/);
  await settle();
  assert.equal(chromium.seen.length, 0);
});

test("a peer with another uid is hung up on before any CDP is sent", async (t) => {
  const { socketPath, chromium } = relay(t, (fd) => require("@zenbu-labs/pixel/native").socketPeerUid(fd) + 1);
  const result = await client(socketPath);
  assert.equal(result.refused, "");
  await settle();
  assert.equal(chromium.seen.length, 0);
});

test("a reply stamped with another session is dropped, and the real reply still arrives", async (t) => {
  const { socketPath, chromium } = relay(t);
  const owner = await client(socketPath);
  const other = await client(socketPath);
  t.after(() => {
    owner.close();
    other.close();
  });
  owner.send({ id: 1, method: "Target.attachToTarget", params: { targetId: "T", flatten: true } });
  const page = (await owner.next()).params.sessionId;
  await owner.next();
  other.send({ id: 5, method: "Test.hold" });
  await settle();
  const held = chromium.seen.find((message) => message.method === "Test.hold");
  chromium.send({ id: held.id, result: { forged: true }, sessionId: page });
  chromium.send({ id: held.id, result: { forged: true } });
  chromium.send({ id: held.id, result: { real: true }, sessionId: held.sessionId });
  assert.deepEqual(await other.next(), { id: 5, result: { real: true } });
});

test("a message from Chromium split into many chunks is reassembled in linear time", async (t) => {
  const { socketPath, chromium } = relay(t);
  const cdp = await client(socketPath);
  t.after(() => cdp.close());
  cdp.send({ id: 1, method: "Test.hold" });
  await settle();
  const held = chromium.seen.find((message) => message.method === "Test.hold");
  const big = "x".repeat(32 * 1024 * 1024);
  const bytes = Buffer.from(`${JSON.stringify({ id: held.id, result: { big }, sessionId: held.sessionId })}\0`);
  const started = Date.now();
  for (let at = 0; at < bytes.length; at += 64 * 1024) chromium.end.write(bytes.subarray(at, at + 64 * 1024));
  const reply = await cdp.next();
  assert.equal(reply.result.big.length, big.length);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
});

test("an oversized message from Chromium is dropped and later messages still flow", async (t) => {
  const { socketPath, chromium } = relay(t, undefined, { maxMessageBytes: 4096, maxBacklogBytes: 1 << 20 });
  const cdp = await client(socketPath);
  t.after(() => cdp.close());
  cdp.send({ id: 1, method: "Test.hold" });
  cdp.send({ id: 2, method: "Test.hold" });
  await settle();
  const [first, second] = chromium.seen.filter((message) => message.method === "Test.hold");
  const huge = Buffer.from(`${JSON.stringify({ id: first.id, result: { big: "y".repeat(10000) }, sessionId: first.sessionId })}\0`);
  for (let at = 0; at < huge.length; at += 1000) chromium.end.write(huge.subarray(at, at + 1000));
  chromium.send({ id: second.id, result: { ok: true }, sessionId: second.sessionId });
  assert.deepEqual(await cdp.next(), { id: 2, result: { ok: true } });
});

test("an oversized frame from a client closes that client", async (t) => {
  const { socketPath, chromium } = relay(t, undefined, { maxMessageBytes: 4096, maxBacklogBytes: 1 << 20 });
  const cdp = await client(socketPath);
  cdp.send({ id: 1, method: "Runtime.evaluate", params: { expression: "z".repeat(10000) } });
  assert.equal(await cdp.next(), null);
  assert.equal(chromium.seen.filter((message) => message.method === "Runtime.evaluate").length, 0);
});

test("a client that stops reading is dropped while other clients keep getting replies", async (t) => {
  const { socketPath, chromium } = relay(t, undefined, { maxMessageBytes: 1 << 20, maxBacklogBytes: 256 * 1024 });
  const stalled = await client(socketPath);
  const healthy = await client(socketPath);
  t.after(() => healthy.close());
  stalled.pause();
  stalled.send({ id: 1, method: "Target.attachToTarget", params: { targetId: "T", flatten: true } });
  await settle();
  const page = chromium.seen.filter((message) => message.method === "Target.attachToTarget").at(-1);
  const pageSession = `page-${page.id}`;
  chromium.send({ method: "Target.attachedToTarget", params: { sessionId: pageSession }, sessionId: page.sessionId });
  chromium.send({ id: page.id, result: { sessionId: pageSession }, sessionId: page.sessionId });
  await settle();
  const noise = "n".repeat(64 * 1024);
  for (let i = 0; i < 200; i++) chromium.send({ method: "Runtime.consoleAPICalled", params: { noise }, sessionId: pageSession });
  healthy.send({ id: 9, method: "Browser.getVersion" });
  assert.deepEqual(await healthy.next(), { id: 9, result: {} });
  stalled.resume();
  await stalled.closed();
});

function maskedFrame(opcode, payload, fin = true) {
  const mask = crypto.randomBytes(4);
  const length = payload.length;
  const header =
    length < 126
      ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | length])
      : Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126, length >> 8, length & 0xff]);
  return Buffer.concat([header, mask, Buffer.from(payload.map((byte, i) => byte ^ mask[i & 3]))]);
}

function rawClient(socketPath) {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    socket.on("error", () => {});
    const closed = new Promise((done) => socket.on("close", done));
    socket.on("connect", () => {
      socket.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    socket.once("data", () => resolve({ socket, closed }));
  });
}

test("pongs count against the backlog, so pinging without reading gets a client dropped", async (t) => {
  const { socketPath } = relay(t, undefined, { maxMessageBytes: 1 << 20, maxBacklogBytes: 4096 });
  const { socket, closed } = await rawClient(socketPath);
  socket.pause();
  const ping = maskedFrame(0x9, Buffer.alloc(125, 1));
  for (let i = 0; i < 20000; i++) socket.write(ping);
  await new Promise((resolve) => setTimeout(resolve, 300));
  socket.resume();
  await closed;
});

test("a control frame over 125 bytes or split across frames closes the client", async (t) => {
  const { socketPath } = relay(t);
  for (const frame of [maskedFrame(0x9, Buffer.alloc(126)), maskedFrame(0x9, Buffer.alloc(10), false)]) {
    const { socket, closed } = await rawClient(socketPath);
    socket.write(frame);
    await closed;
  }
});

test("a single message that would take an unread backlog past the cap drops the client before it is queued", async (t) => {
  const { socketPath, chromium } = relay(t, undefined, { maxMessageBytes: 8 << 20, maxBacklogBytes: 256 * 1024 });
  const stalled = await client(socketPath);
  stalled.pause();
  stalled.send({ id: 1, method: "Test.hold" });
  await settle();
  const held = chromium.seen.find((message) => message.method === "Test.hold");
  chromium.send({ id: held.id, result: { big: "b".repeat(4 << 20) }, sessionId: held.sessionId });
  stalled.resume();
  await stalled.closed();
});

test("a client that never finishes its handshake is dropped", async (t) => {
  const { socketPath } = relay(t, undefined, { handshakeTimeoutMs: 200 });
  const socket = net.connect(socketPath);
  socket.on("error", () => {});
  socket.on("connect", () => socket.write("GET / HTTP/1.1\r\nHost: x\r\n"));
  const started = Date.now();
  await new Promise((resolve) => socket.on("close", resolve));
  assert.ok(Date.now() - started < 2000);
});

test("connections past the cap are turned away", async (t) => {
  const { socketPath } = relay(t, undefined, { maxConnections: 4 });
  const sockets = [];
  for (let i = 0; i < 10; i++) {
    const socket = net.connect(socketPath);
    socket.on("error", () => {});
    sockets.push(new Promise((resolve) => socket.on("close", () => resolve(true))));
    t.after(() => socket.destroy());
  }
  const early = await Promise.all(sockets.map((closed) => Promise.race([closed, new Promise((r) => setTimeout(() => r(false), 300))])));
  assert.ok(early.filter(Boolean).length >= 6, `${early.filter(Boolean).length} of 10 turned away`);
});

test("a client may only have so many requests waiting on Chromium", async (t) => {
  const { socketPath } = relay(t, undefined, { maxPending: 5 });
  const cdp = await client(socketPath);
  for (let id = 1; id <= 20; id++) cdp.send({ id, method: "Test.hold" });
  await cdp.closed();
});

test("a refused handshake is closed from our side even if the client never hangs up", async (t) => {
  const { socketPath, server } = relay(t);
  const socket = net.createConnection({ path: socketPath, allowHalfOpen: true });
  t.after(() => socket.destroy());
  socket.on("error", () => {});
  socket.on("connect", () => socket.write("GET / HTTP/1.1\r\nHost: x\r\nOrigin: https://evil.example\r\nUpgrade: websocket\r\nSec-WebSocket-Key: a\r\nSec-WebSocket-Version: 13\r\n\r\n"));
  socket.resume();
  await new Promise((resolve) => socket.on("end", resolve));
  await settle();
  const open = await new Promise((resolve) => server.getConnections((_error, count) => resolve(count)));
  assert.equal(open, 0, "the server let go of the refused connection");
});

async function ask(cdp, chromium, id, method, params) {
  const before = chromium.seen.filter((message) => message.method === method).length;
  cdp.send({ id, method, params });
  const reply = await cdp.next();
  assert.equal(reply.id, id);
  return { reply, forwarded: chromium.seen.filter((message) => message.method === method).length > before };
}

test("relay clients cannot give a page a CDP connection", async (t) => {
  const { socketPath, chromium } = relay(t);
  const cdp = await client(socketPath);
  t.after(() => cdp.close());
  const { reply, forwarded } = await ask(cdp, chromium, 1, "Target.exposeDevToolsProtocol", { targetId: "T", bindingName: "cdp" });
  assert.ok(reply.error);
  assert.equal(forwarded, false);
});

test("the ssh proxy's password never reaches a CDP client", async (t) => {
  const { socketPath, chromium } = relay(t);
  const cdp = await client(socketPath);
  t.after(() => cdp.close());
  cdp.send({ id: 1, method: "Network.enable" });
  await cdp.next();
  const secret = "Basic dGVybWluYWwtYnJvd3Nlcjpzc2g=";
  chromium.send({ method: "Network.requestWillBeSentExtraInfo", params: { requestId: "1", headers: { "Proxy-Authorization": secret, Cookie: "a=b" } }, sessionId: "browser-1" });
  chromium.send({ method: "Network.requestWillBeSent", params: { requestId: "1", request: { url: "http://x/", headers: { "proxy-authorization": secret } }, redirectResponse: { requestHeaders: { "Proxy-Authorization": secret }, requestHeadersText: `GET / HTTP/1.1\r\nProxy-Authorization: ${secret}\r\nHost: x\r\n` } }, sessionId: "browser-1" });
  chromium.send({ method: "Fetch.requestPaused", params: { requestId: "2", request: { url: "http://x/", headers: { "Proxy-Authorization": secret } } }, sessionId: "browser-1" });
  const events = [await cdp.next(), await cdp.next(), await cdp.next()];
  for (const event of events) assert.doesNotMatch(JSON.stringify(event), /dGVybWluYWw|proxy-authorization/i);
  assert.equal(events[0].params.headers.Cookie, "a=b");
  assert.match(events[1].params.redirectResponse.requestHeadersText, /Host: x/);
});

test("commands can't be wrapped past the policy, and every session is flat", async (t) => {
  const { socketPath, chromium } = relay(t);
  const cdp = await client(socketPath);
  t.after(() => cdp.close());
  let id = 1;
  const inner = JSON.stringify({ id: 1, method: "Page.navigate", params: { url: "file:///etc/hosts" } });
  for (const [method, params] of [
    ["Target.sendMessageToTarget", { sessionId: "S", message: inner }],
    ["Target.attachToTarget", { targetId: "T", flatten: false }],
    ["Target.attachToTarget", { targetId: "T" }],
    ["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false }],
    ["Target.autoAttachRelated", { targetId: "T", waitForDebuggerOnStart: false }],
    ["Browser.grantPermissions", { permissions: ["videoCapture", "audioCapture"] }],
    ["Browser.setPermission", { permission: { name: "camera" }, setting: "granted" }],
  ]) {
    const { reply, forwarded } = await ask(cdp, chromium, id++, method, params);
    assert.ok(reply.error, `${method} ${JSON.stringify(params)} was allowed`);
    assert.equal(forwarded, false, method);
  }
  const flat = await ask(cdp, chromium, id++, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  assert.equal(flat.reply.error, undefined);
});

function rawRequest(port, head) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let text = "";
    socket.on("data", (chunk) => (text += chunk.toString("latin1")));
    socket.on("close", () => resolve(text));
    socket.on("error", () => resolve(text));
    socket.on("connect", () => socket.write(head));
    setTimeout(() => socket.destroy(), 2000);
  });
}

test("the opt-in debugging port serves /json/version and the same relay, on loopback only", async (t) => {
  const { openPort } = relay(t);
  const { server: portServer, port } = await openPort(0);
  t.after(() => portServer.close());
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  assert.equal(version.webSocketDebuggerUrl, `ws://127.0.0.1:${port}/devtools/browser/terminal-browser`);
  const key = crypto.randomBytes(16).toString("base64");
  const upgrade = (host, extra = "") =>
    `GET /devtools/browser/terminal-browser HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`;
  assert.match(await rawRequest(port, upgrade(`127.0.0.1:${port}`)), /^HTTP\/1.1 101/);
  assert.match(await rawRequest(port, upgrade(`localhost:${port}`)), /^HTTP\/1.1 101/);
  assert.match(await rawRequest(port, upgrade("attacker.example")), /^HTTP\/1.1 403/, "a rebinding domain is refused");
  assert.match(await rawRequest(port, upgrade(`127.0.0.1:${port}`, "Origin: https://attacker.example\r\n")), /^HTTP\/1.1 403/, "a web page is refused");
  assert.match(await rawRequest(port, `GET /json/version HTTP/1.1\r\nHost: attacker.example\r\n\r\n`), /^HTTP\/1.1 403/);
  assert.match(await rawRequest(port, `GET /json/new?about:blank HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`), /^HTTP\/1.1 404/);
  for (const [first, second] of [["attacker.example", `127.0.0.1:${port}`], [`127.0.0.1:${port}`, "attacker.example"], [`127.0.0.1:${port}`, `127.0.0.1:${port}`]]) {
    assert.match(await rawRequest(port, `GET /json/version HTTP/1.1\r\nHost: ${first}\r\nhost: ${second}\r\n\r\n`), /^HTTP\/1.1 400/, "a repeated Host is refused");
    assert.match(await rawRequest(port, upgrade(first, `Host: ${second}\r\n`)), /^HTTP\/1.1 400/, "a repeated Host is refused");
  }
  const lines = require("node:child_process").execFileSync("lsof", ["-nP", "-a", "-p", String(process.pid), "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8" });
  assert.match(lines, new RegExp(`127\\.0\\.0\\.1:${port} \\(LISTEN\\)`));
});
