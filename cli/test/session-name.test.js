const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

const { sessionName } = require("../dist/action.js");

const MAX_SOCKET_PATH = 103;

test("the agent socket fits the unix socket path limit under the default macOS state directory", () => {
  const socketDir = "/Users/jonathanwilliams/.local/state/terminal-browser-8c25e3c3/agent-browser";
  const socket = `${path.join(socketDir, sessionName({ key: "48213-12", pid: 48213 }))}.sock`;
  assert.ok(Buffer.byteLength(socket) <= MAX_SOCKET_PATH, `${socket} is ${Buffer.byteLength(socket)} bytes`);
});

test("session names stay distinct per browser", () => {
  assert.notEqual(sessionName({ key: "100-1", pid: 100 }), sessionName({ key: "100-2", pid: 100 }));
  assert.equal(sessionName({ key: null, pid: 4242 }), sessionName({ key: null, pid: 4242 }));
});
