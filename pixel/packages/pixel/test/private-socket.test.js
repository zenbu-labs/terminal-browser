const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { connectionUid, listenPrivately, peerAllowed, privateServer } = require("../dist/host/private-socket.js");

const uid = process.getuid();

function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tb-sock-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function exchange(socketPath) {
  return new Promise((resolve) => {
    const client = net.connect(socketPath);
    let reply = "";
    client.on("connect", () => client.write("ping\n"));
    client.on("data", (chunk) => (reply += chunk));
    client.on("error", () => {});
    client.on("close", () => resolve(reply));
  });
}

function echoServer(read) {
  return privateServer((connection) => {
    connection.on("data", () => connection.end("pong\n"));
  }, read);
}

test("only a peer with our own uid is let through", () => {
  assert.equal(peerAllowed(uid, uid), true);
  assert.equal(peerAllowed(uid + 1, uid), false);
  assert.equal(peerAllowed(0, uid === 0 ? 1 : uid), false);
  assert.equal(peerAllowed(null, uid), false);
});

test("a socket created under a permissive umask is 0600 in a 0700 directory, and answers our own user", async (t) => {
  const socketPath = path.join(scratch(t), "runtime", "app", "daemon.sock");
  const server = echoServer();
  const previous = process.umask(0o000);
  try {
    listenPrivately(server, socketPath);
  } finally {
    process.umask(previous);
  }
  t.after(() => server.close());
  assert.equal(process.umask(), previous);
  assert.equal(fs.lstatSync(socketPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(socketPath)).mode & 0o777, 0o700);
  assert.equal(await exchange(socketPath), "pong\n");
});

test("the kernel's peer uid is what the server checks, and another uid is hung up on", async (t) => {
  const socketPath = path.join(scratch(t), "app", "daemon.sock");
  const seen = [];
  const server = echoServer((fd) => {
    const peer = require("../dist/react/native.js").socketPeerUid(fd);
    seen.push(peer);
    return peer + 1;
  });
  listenPrivately(server, socketPath);
  t.after(() => server.close());
  assert.equal(await exchange(socketPath), "");
  assert.deepEqual(seen, [uid]);
});

test("a connection without a readable descriptor or credentials is refused", () => {
  assert.equal(connectionUid({}), null);
  assert.equal(connectionUid({ _handle: { fd: 3 } }, () => { throw new Error("EINVAL"); }), null);
});

test("a socket directory that others can write to is refused before anything listens", (t) => {
  const shared = path.join(scratch(t), "shared");
  fs.mkdirSync(shared);
  fs.chmodSync(shared, 0o777);
  const server = echoServer();
  assert.throws(() => listenPrivately(server, path.join(shared, "daemon.sock")), /Refusing to use/);
  assert.equal(server.listening, false);
});

const { connectPrivately, privateSocketPath, UntrustedSocketError } = require("../dist/host/private-socket.js");

test("connectPrivately reaches a socket of ours through its real path", async (t) => {
  const root = scratch(t);
  fs.mkdirSync(path.join(root, "real"), { mode: 0o700 });
  fs.symlinkSync(path.join(root, "real"), path.join(root, "alias"));
  const server = echoServer();
  const bound = listenPrivately(server, path.join(root, "alias", "app", "daemon.sock"));
  t.after(() => server.close());
  assert.equal(bound, path.join(root, "real", "app", "daemon.sock"));
  assert.equal(privateSocketPath(path.join(root, "alias", "app", "daemon.sock")), bound);
  const socket = await connectPrivately(path.join(root, "alias", "app", "daemon.sock"));
  socket.destroy();
});

test("connectPrivately refuses a server the kernel says is another user, before sending anything", async (t) => {
  const socketPath = path.join(scratch(t), "app", "daemon.sock");
  let received = 0;
  const server = net.createServer((connection) => connection.on("data", (chunk) => (received += chunk.length)));
  listenPrivately(server, socketPath);
  t.after(() => server.close());
  const otherUser = (fd) => require("../dist/react/native.js").socketPeerUid(fd) + 1;
  await assert.rejects(connectPrivately(socketPath, otherUser), UntrustedSocketError);
  assert.equal(received, 0);
});

test("a link swapped back and forth during connects never leads a client to the folder the check refuses", async (t) => {
  const root = scratch(t);
  const good = path.join(root, "good");
  const evil = path.join(root, "evil");
  fs.mkdirSync(good, { mode: 0o700 });
  fs.mkdirSync(evil);
  fs.chmodSync(evil, 0o777);
  const link = path.join(root, "link");
  fs.symlinkSync(good, link);
  const ours = echoServer();
  listenPrivately(ours, path.join(good, "app", "daemon.sock"));
  fs.mkdirSync(path.join(evil, "app"), { mode: 0o777 });
  let stolen = 0;
  const impostor = net.createServer((connection) => {
    stolen++;
    connection.destroy();
  });
  impostor.listen(path.join(evil, "app", "daemon.sock"));
  t.after(() => {
    ours.close();
    impostor.close();
  });
  const flipper = require("node:child_process").spawn(process.execPath, [
    "-e",
    `const fs = require("node:fs");
     const [link, good, evil] = process.argv.slice(1);
     let flip = false;
     setInterval(() => {
       fs.symlinkSync(flip ? good : evil, link + ".next");
       fs.renameSync(link + ".next", link);
       flip = !flip;
     }, 0);`,
    link,
    good,
    evil,
  ]);
  t.after(() => flipper.kill());
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (let i = 0; i < 200; i++) {
    try {
      (await connectPrivately(path.join(link, "app", "daemon.sock"))).destroy();
    } catch {}
  }
  assert.equal(stolen, 0);
  flipper.kill();
  await new Promise((resolve) => flipper.once("exit", resolve));
  fs.symlinkSync(good, `${link}.settled`);
  fs.renameSync(`${link}.settled`, link);
  (await connectPrivately(path.join(link, "app", "daemon.sock"))).destroy();
  assert.equal(stolen, 0);
});
