const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const net = require("node:net");
const { test } = require("node:test");

const { detect } = require("../dist/terminal/index.js");

const inherited = { HERDR_ENV: "1", HERDR_PANE_ID: "wC:p5", HERDR_TAB_ID: "wC:t5", HERDR_WORKSPACE_ID: "wC" };
const live = { pane_id: "w0:p2", tab_id: "w0:t2", workspace_id: "w0" };
const context = { tty: null, cwd: "/" };
const request = {
  from: { id: "wC:p5", tab: "wC:t5" },
  direction: "right",
  command: ["terminal-browser", "open", "about:blank"],
  size: 0.4,
  tty: null,
};

function recorded(outputs) {
  const commands = [];
  return {
    commands,
    run: async (bin, args) => {
      const command = [bin, ...args].join(" ");
      commands.push(command);
      assert.ok(Object.hasOwn(outputs, command), `unexpected command: ${command}`);
      const output = outputs[command];
      if (output instanceof Error) throw output;
      return typeof output === "string" ? output : JSON.stringify(output);
    },
  };
}

for (const [name, pane] of [
  ["valid identifiers", { pane_id: "wC:p5", tab_id: "wC:t5", workspace_id: "wC" }],
  ["a move to another tab", { pane_id: "wC:p5", tab_id: "wC:t6", workspace_id: "wC" }],
  ["a move to another workspace", live],
]) {
  test(`herdr resolves ${name} through the supplied caller, regardless of focus`, async () => {
    const { run, commands } = recorded({ "herdr pane current --pane wC:p5": { result: { pane } } });
    const terminal = detect(inherited, run);
    assert.deepEqual(await terminal.getCurrentPane(context), { id: pane.pane_id, tab: pane.tab_id });
    assert.deepEqual(commands, ["herdr pane current --pane wC:p5"]);
  });
}

test("herdr splits the resolved pane when the source has moved since discovery", async () => {
  const { run, commands } = recorded({
    "herdr pane current --pane wC:p5": { result: { pane: live } },
    "herdr pane split --pane w0:p2 --direction right --focus --ratio 0.4 --right-click pane": {
      result: { pane: { pane_id: "w0:p3" } },
    },
    "herdr pane run w0:p3 terminal-browser open about:blank": "",
  });
  await detect(inherited, run).split(request);
  assert.deepEqual(commands, [
    "herdr pane current --pane wC:p5",
    "herdr pane split --pane w0:p2 --direction right --focus --ratio 0.4 --right-click pane",
    "herdr pane run w0:p3 terminal-browser open about:blank",
  ]);
});

test("herdr lists browsers in the live workspace instead of the inherited workspace", async () => {
  const { run } = recorded({
    "herdr pane current --pane wC:p5": { result: { pane: live } },
    "herdr pane list": { result: { panes: [
      live,
      { pane_id: "wC:p9", tab_id: "wC:t5", workspace_id: "wC" },
    ] } },
    "herdr pane process-info --pane w0:p2": {
      result: { process_info: { shell_pid: 123, foreground_processes: [{ cmdline: "terminal-browser open" }] } },
    },
    "ps -o pid=,tty= -p 123": "123 ttys002\n",
  });
  assert.deepEqual(await detect(inherited, run).listPanes(), [
    { id: "w0:p2", tab: "w0:t2", tty: "/dev/ttys002", command: "terminal-browser open" },
  ]);
});

for (const [name, output] of [
  ["an unknown caller", new Error('{"error":{"code":"pane_not_found","message":"pane not found"}}')],
  ["an unavailable server", new Error("connect ECONNREFUSED")],
  ["invalid JSON", "not JSON"],
  ["an error response", { error: { code: "pane_not_found", message: "pane not found" } }],
  ["a missing pane", { result: {} }],
  ["a missing tab", { result: { pane: { pane_id: "w0:p2", workspace_id: "w0" } } }],
  ["a missing workspace", { result: { pane: { pane_id: "w0:p2", tab_id: "w0:t2" } } }],
  ["an empty pane identifier", { result: { pane: { ...live, pane_id: " " } } }],
]) {
  test(`herdr reports ${name} before changing panes`, async () => {
    const { run, commands } = recorded({ "herdr pane current --pane wC:p5": output });
    const terminal = detect(inherited, run);
    for (const operation of [
      () => terminal.getCurrentPane(context),
      () => terminal.split(request),
      () => terminal.focusPane("w0:p9"),
    ]) {
      await assert.rejects(operation, (error) => {
        assert.match(error.message, /resolve.*Herdr.*pane/i);
        assert.match(error.message, /herdr pane current/);
        return true;
      });
    }
    assert.ok(commands.every((command) => command === "herdr pane current --pane wC:p5"));
  });
}

for (const paneId of [undefined, "", " "]) {
  test(`herdr never queries the focused pane with caller identifier ${JSON.stringify(paneId)}`, async () => {
    const { run, commands } = recorded({});
    const terminal = detect({ HERDR_ENV: "1", HERDR_PANE_ID: paneId }, run);
    assert.equal(terminal?.name, "herdr");
    await assert.rejects(() => terminal.getCurrentPane(context), /HERDR_PANE_ID/);
    assert.deepEqual(commands, []);
  });
}

for (const [name, target, focusCommands] of [
  ["the live caller tab", { pane_id: "w0:p9", tab_id: "w0:t2", workspace_id: "w0" }, []],
  ["another tab matching the stale environment", { pane_id: "wC:p9", tab_id: "wC:t5", workspace_id: "wC" }, ["herdr tab focus wC:t5"]],
]) {
  test(`herdr compares focus targets with ${name}`, async (t) => {
    const { run, commands } = recorded({
      "herdr pane current --pane wC:p5": { result: { pane: live } },
      "herdr pane get wC:p9": { result: { pane: target } },
      "herdr tab focus wC:t5": "",
    });
    const calls = [];
    t.mock.method(net, "connect", () => {
      const socket = new EventEmitter();
      socket.setTimeout = () => socket;
      socket.end = () => socket;
      socket.write = (data) => {
        calls.push(JSON.parse(data));
        socket.emit("data", Buffer.from('{"result":{}}\n'));
      };
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    });
    await detect(inherited, run).focusPane("wC:p9");
    assert.deepEqual(commands, ["herdr pane current --pane wC:p5", "herdr pane get wC:p9", ...focusCommands]);
    assert.deepEqual(calls, [{ id: "pixel", method: "pane.focus", params: { pane_id: target.pane_id } }]);
  });
}
