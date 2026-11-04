const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const { test } = require("node:test");

const { socketPair } = require("../dist/socket-pair.js");

test("the daemon's debugging pipe is a kernel socket pair, with nothing created on disk", async () => {
  const before = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("terminal-browser-pair-"));
  const sockets = socketPair();
  const after = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("terminal-browser-pair-"));
  assert.deepEqual(after, before);
  const [one, two] = sockets.pair.map((fd) => new net.Socket({ fd, readable: true, writable: true }));
  const got = new Promise((resolve) => two.once("data", (chunk) => resolve(chunk.toString())));
  one.write("ping");
  assert.equal(await got, "ping");
  one.destroy();
  two.destroy();
});
