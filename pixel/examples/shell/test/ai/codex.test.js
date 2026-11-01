const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { CodexSession, listCodexModels } = require("../../dist/ai/codex.js");

const FAKE = path.join(__dirname, "..", "..", "test-support", "fixtures", "fake-codex");
const context = { cwd: "/tmp", commandLine: "", recentOutput: "", selection: "", lastRun: null };

function recorder() {
  const seen = [];
  const waiters = [];
  const push = (entry) => {
    seen.push(entry);
    for (const waiter of [...waiters]) if (waiter.match(entry)) waiters.splice(waiters.indexOf(waiter), 1) && waiter.resolve();
  };
  const events = {
    text: (delta) => push(["text", delta]),
    command: (command, final) => push(["command", command, final]),
    status: (status) => push(["status", status]),
    done: () => push(["done"]),
    failed: (message) => push(["failed", message]),
    models: (harness, found) => push(["models", harness, found]),
  };
  const until = (match) =>
    seen.some(match)
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
          waiters.push({ match, resolve });
          setTimeout(() => reject(new Error(`timed out; saw ${JSON.stringify(seen)}`)), 5000);
        });
  return { seen, events, until };
}

function withLog(signedOut = false) {
  if (signedOut) process.env.FAKE_CODEX_SIGNED_OUT = "1";
  else delete process.env.FAKE_CODEX_SIGNED_OUT;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pxsh-codex-")), "log.jsonl");
  process.env.FAKE_CODEX_LOG = file;
  return () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse) : []);
}

const choice = { harness: "codex", model: "gpt-6-luna", effort: "low", fast: true };

test("a codex turn streams text, puts the command on the line, is ready before the turn ends and hides text after the command", async () => {
  const sent = withLog();
  const { seen, events, until } = recorder();
  const session = new CodexSession(events, choice, FAKE, os.tmpdir());
  try {
    session.ask("list files", context);
    await until((e) => e[0] === "command");
    const done = seen.findIndex((e) => e[0] === "done");
    assert.deepEqual(seen.find((e) => e[0] === "command"), ["command", "ls -la", true]);
    assert.ok(done > seen.findIndex((e) => e[0] === "command"));
    assert.ok(seen.some((e) => e[0] === "text" && e[1] === "Listing. "));
    session.ask("question after", context);
    await until((e) => e[0] === "text" && e[1] === "lo");
    assert.ok(!seen.some((e) => e[0] === "text" && e[1] === "Done."));
    const thread = sent().find((m) => m.method === "thread/start").params;
    assert.equal(thread.sandbox, "read-only");
    assert.equal(thread.approvalPolicy, "never");
    assert.equal(thread.ephemeral, true);
    assert.equal(thread.dynamicTools[0].name, "write_command");
    const turn = sent().find((m) => m.method === "turn/start").params;
    assert.deepEqual([turn.model, turn.effort, turn.serviceTier], ["gpt-6-luna", "low", "priority"]);
    const toolReply = sent().find((m) => m.id === 1000);
    assert.equal(toolReply.result.success, true);
    assert.match(toolReply.result.contentItems[0].text, /End your turn/);
  } finally {
    session.close();
  }
});

test("a follow-up goes to the same thread with the newest choice", async () => {
  const sent = withLog();
  const { seen, events, until } = recorder();
  const session = new CodexSession(events, choice, FAKE, os.tmpdir());
  try {
    session.ask("question one", context);
    await until((e) => e[0] === "done");
    session.setChoice({ harness: "codex", model: "gpt-6.1-sol", effort: "high", fast: false });
    session.ask("question two", context);
    await until(() => seen.filter((e) => e[0] === "done").length === 2);
    const turns = sent().filter((m) => m.method === "turn/start").map((m) => m.params);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].threadId, turns[1].threadId);
    assert.deepEqual([turns[1].model, turns[1].effort, turns[1].serviceTier], ["gpt-6.1-sol", "high", "default"]);
    assert.equal(sent().filter((m) => m.method === "thread/start").length, 1);
    assert.equal(seen.filter((e) => e[0] === "text").map((e) => e[1]).join(""), "HelloHello");
  } finally {
    session.close();
  }
});

test("a question asked while a turn runs waits for it to end", async () => {
  withLog();
  const { seen, events, until } = recorder();
  const session = new CodexSession(events, choice, FAKE, os.tmpdir());
  try {
    session.ask("question one", context);
    session.ask("question two", context);
    await until(() => seen.filter((e) => e[0] === "done").length === 2);
    assert.equal(seen.filter((e) => e[0] === "text").length, 4);
  } finally {
    session.close();
  }
});

test("stop interrupts the running turn", async () => {
  const sent = withLog();
  const { seen, events, until } = recorder();
  const session = new CodexSession(events, choice, FAKE, os.tmpdir());
  try {
    session.ask("slow one", context);
    await until((e) => e[0] === "status" && e[1] === "Running sleep 9");
    await session.stop();
    await until((e) => e[0] === "done");
    assert.ok(sent().some((m) => m.method === "turn/interrupt" && m.params.turnId === "turn-1"));
    assert.ok(!seen.some((e) => e[0] === "failed"));
  } finally {
    session.close();
  }
});

test("a failed turn reports its error and ends", async () => {
  withLog();
  const { seen, events, until } = recorder();
  const session = new CodexSession(events, choice, FAKE, os.tmpdir());
  try {
    session.ask("fail now", context);
    await until((e) => e[0] === "done");
    assert.deepEqual(seen.find((e) => e[0] === "failed"), ["failed", "boom"]);
  } finally {
    session.close();
  }
});

test("the session reports the models codex offers, and whether it is signed in", async () => {
  withLog(true);
  const { seen, events, until } = recorder();
  const session = new CodexSession(events, choice, FAKE, os.tmpdir());
  try {
    await until((e) => e[0] === "models");
    const [, harness, found] = seen.find((e) => e[0] === "models");
    assert.equal(harness, "codex");
    assert.equal(found.signedIn, false);
    assert.deepEqual(
      found.models.map((m) => m.id),
      ["gpt-6.1-sol", "gpt-6-luna", "gpt-5.5"],
    );
  } finally {
    session.close();
  }
});

test("listing codex models without a conversation", async () => {
  withLog();
  const found = await listCodexModels(FAKE);
  assert.equal(found.models[0].fastTier, "priority");
  assert.equal(await listCodexModels(path.join(os.tmpdir(), "no-such-codex")), null);
});

test("a signed-out codex fails the question at once instead of retrying", async () => {
  withLog(true);
  const { seen, events, until } = recorder();
  const session = new CodexSession(events, choice, FAKE, os.tmpdir());
  try {
    session.ask("list files", context);
    await until((e) => e[0] === "done");
    assert.match(seen.find((e) => e[0] === "failed")[1], /codex login/);
  } finally {
    session.close();
  }
});
