const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { OwnerServer } = require("../dist/host/server.js");

const cell = () => ({ width: 8, height: 16 });

function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pixel-owner-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function askForInfo(socketPath) {
  return new Promise((resolve) => {
    const client = net.connect(socketPath);
    let reply = "";
    client.setEncoding("utf8");
    client.on("connect", () => client.write(JSON.stringify({ id: "1", method: "pane.graphics.info" }) + "\n"));
    client.on("data", (chunk) => (reply += chunk));
    client.on("error", () => {});
    client.on("close", () => resolve(reply));
  });
}

test("the owner socket is 0600 in a 0700 directory even under a permissive umask", (t) => {
  const socketPath = path.join(scratch(t), "state", "instances", "t.sock");
  const previous = process.umask(0o000);
  let server;
  try {
    server = new OwnerServer(socketPath, cell);
  } finally {
    process.umask(previous);
  }
  t.after(() => server.stop());
  assert.equal(fs.lstatSync(socketPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(socketPath)).mode & 0o777, 0o700);
});

test("the owner server keeps talking to our own user", async (t) => {
  const socketPath = path.join(scratch(t), "instances", "tty.sock");
  const server = new OwnerServer(socketPath, cell);
  t.after(() => server.stop());
  assert.equal(JSON.parse(await askForInfo(socketPath)).result.cell_width_px, 8);
});

test("the owner server hangs up on a peer the kernel says is another user", async (t) => {
  const socketPath = path.join(scratch(t), "instances", "tty.sock");
  const seen = [];
  const server = new OwnerServer(socketPath, cell, (fd) => {
    const peer = require("../dist/react/native.js").socketPeerUid(fd);
    seen.push(peer);
    return peer + 1;
  });
  t.after(() => server.stop());
  assert.equal(await askForInfo(socketPath), "");
  assert.deepEqual(seen, [process.getuid()]);
});
