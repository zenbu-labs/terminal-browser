const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { socketTerminal, TERMINAL_SOCKET_PROTOCOL } = require("../dist/index.js");

const ALL = ["getCurrentPane", "split", "listPanes", "neighbor", "sendText", "focusPane"];

async function fakeTerminal(answers) {
  const socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tb-term-")), "term.sock");
  const requests = [];
  const server = net.createServer((connection) => {
    let buffer = "";
    connection.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      requests.push(request);
      const answer = answers[request.method];
      const reply = typeof answer === "function" ? answer(request) : { id: request.id, result: answer };
      connection.end(reply === null ? "" : `${JSON.stringify(reply)}\n`);
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const hello = { name: "fake", methods: ALL };

test("every request carries an id, the method, its params, and who is asking", async () => {
  const fake = await fakeTerminal({
    hello,
    getCurrentPane: { pane: { id: "p1", tab: "t1" } },
    split: {},
    listPanes: { panes: [{ id: "p1", tab: "t1", tty: "/dev/ttys001", command: "claude" }] },
    neighbor: { pane: null },
    sendText: {},
    focusPane: {},
  });
  try {
    const terminal = socketTerminal(fake.socketPath);
    await terminal.prepare();
    assert.equal(terminal.name, "fake");

    assert.deepEqual(await terminal.getCurrentPane({ tty: "/dev/ttys001", cwd: "/work" }), { id: "p1", tab: "t1" });
    const split = { from: { id: "p1", tab: "t1" }, direction: "right", command: ["tb", "open"], size: 0.4, tty: "/dev/ttys001" };
    await terminal.split(split);
    assert.deepEqual(await terminal.listPanes({ tty: "/dev/ttys001", commands: () => false }), [
      { id: "p1", tab: "t1", tty: "/dev/ttys001", command: "claude" },
    ]);
    assert.equal(await terminal.neighbor({ id: "p1", tab: "t1" }, "down"), null);
    await terminal.sendText("p1", "hello\n");
    await terminal.focusPane("p1");

    assert.deepEqual(
      fake.requests.map((request) => [request.method, request.params]),
      [
        ["hello", { protocol: TERMINAL_SOCKET_PROTOCOL }],
        ["getCurrentPane", { tty: "/dev/ttys001", cwd: "/work" }],
        ["split", split],
        ["listPanes", { tty: "/dev/ttys001" }],
        ["neighbor", { from: { id: "p1", tab: "t1" }, direction: "down" }],
        ["sendText", { pane: "p1", text: "hello\n" }],
        ["focusPane", { pane: "p1" }],
      ],
    );
    for (const request of fake.requests) {
      assert.equal(typeof request.id, "string");
      assert.deepEqual(request.caller, { pid: process.pid, cwd: process.cwd() });
    }
  } finally {
    await fake.close();
  }
});

test("hello decides which operations the terminal offers", async () => {
  const fake = await fakeTerminal({ hello: { name: "narrow", methods: ["getCurrentPane", "sendText"] } });
  try {
    const terminal = socketTerminal(fake.socketPath);
    assert.equal(terminal.name, "socket");
    assert.equal(typeof terminal.split, "function");
    await terminal.prepare();
    assert.equal(terminal.name, "narrow");
    assert.equal(terminal.split, undefined);
    assert.equal(terminal.listPanes, undefined);
    assert.equal(terminal.neighbor, undefined);
    assert.equal(terminal.focusPane, undefined);
    assert.equal(typeof terminal.getCurrentPane, "function");
    assert.equal(typeof terminal.sendText, "function");
  } finally {
    await fake.close();
  }
});

test("an error reply becomes a thrown error with the terminal's message", async () => {
  const fake = await fakeTerminal({
    split: (request) => ({ id: request.id, error: { message: "only splits right" } }),
  });
  try {
    const terminal = socketTerminal(fake.socketPath);
    await assert.rejects(
      terminal.split({ from: { id: "p1", tab: "t1" }, direction: "up", command: [], size: null, tty: null }),
      { message: "only splits right" },
    );
  } finally {
    await fake.close();
  }
});

test("replies that do not follow the protocol are refused", async () => {
  const fake = await fakeTerminal({
    getCurrentPane: (request) => ({ id: "someone-else", result: { pane: null } }),
    neighbor: { pane: { id: 7 } },
  });
  try {
    const terminal = socketTerminal(fake.socketPath);
    await assert.rejects(terminal.getCurrentPane({ tty: null, cwd: "/" }), /wrong id/);
    await assert.rejects(terminal.neighbor({ id: "p1", tab: "t1" }, "left"), /unexpected result/);
  } finally {
    await fake.close();
  }
});

test("nothing listening is reported by socket path and env var", async () => {
  const terminal = socketTerminal(path.join(os.tmpdir(), "tb-term-nobody.sock"));
  await assert.rejects(terminal.prepare(), /nothing is listening at .*tb-term-nobody\.sock \(TERMINAL_BROWSER_TERMINAL_SOCKET\)/);
});
