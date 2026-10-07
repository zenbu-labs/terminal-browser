const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { test } = require("node:test");

// RecordSession itself only imports @zenbu-labs/pixel for types, but ./compositor, ./recorder and
// ../ui/markup-canvas pull the package in at runtime, and loading it needs electron plus a
// prebuilt native addon. Nothing it exports is reached through the host and target stubs below,
// so the package resolves to an empty namespace here and the session class under test is real.
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "@zenbu-labs/pixel") return {};
  return load.call(this, request, ...rest);
};
const { RecordSession } = require("../dist/record/session.js");

const FRAME = { tMs: 0, width: 4, height: 4, dropsBefore: 0 };
const TIMEOUT_MS = 40;
const PAST_TIMEOUT_MS = 250;

// one captured frame by default, so complete() has something to write and does not fall
// through to discard()
function harness({ frames = [FRAME] } = {}) {
  const calls = { finished: 0, toasts: [], clipboard: [] };
  let dir = null;
  const capture = {
    stop: () => ({ durationMs: 200 }),
    index: () => ({ frames }),
    frame: () => Buffer.alloc(FRAME.width * FRAME.height * 4),
    release: () => {},
  };
  const view = {
    cdp: async () => {},
    webContents: { debugger: { on: () => {}, removeListener: () => {} } },
    recording: {
      pinFrameRate: () => {},
      onFrame: () => () => {},
      start: (framesDir) => {
        dir = path.dirname(framesDir);
        return capture;
      },
      invalidate: () => {},
      frameSize: () => ({ width: FRAME.width, height: FRAME.height }),
    },
  };
  const host = {
    root: { createSurface: () => ({ present: () => {}, close: () => {} }) },
    layout: () => null,
    canvasRect: () => ({ x: 0, y: 0, width: 100, height: 100 }),
    page: () => ({ url: "https://example.test/", title: "example" }),
    fontFile: () => "",
    requestRender: () => {},
    blurToOverlay: () => {},
    refocusPage: () => {},
    reviewStarted: () => {},
    setKeyCapture: () => {},
    setClipboard: (text) => calls.clipboard.push(text),
    toast: (name, state) => calls.toasts.push(`${state}:${name}`),
    finished: () => {
      calls.finished += 1;
    },
    isRecordKey: () => false,
    recordKeyLabel: () => "ctrl+r",
  };
  return {
    calls,
    cleanup: () => {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    },
    // the agent shape: session.tsx only passes timeoutMs together with agent: true
    create: (options = { agent: true, timeoutMs: TIMEOUT_MS }) =>
      RecordSession.create(host, { tabId: 1, handle: () => view }, options),
  };
}

const after = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("the auto-stop timeout completes a recording nobody stops", async () => {
  const { calls, cleanup, create } = harness();
  const session = await create();
  try {
    assert.equal(session.active, true);
    assert.equal(calls.finished, 0);
    await after(PAST_TIMEOUT_MS);
    assert.equal(session.active, false);
    assert.equal(calls.finished, 1);
    // agent recordings do not touch the clipboard
    assert.deepEqual(calls.clipboard, []);
  } finally {
    session.dispose();
    cleanup();
  }
});

test("dispose clears the auto-stop timer, so it never fires afterwards", async () => {
  const { calls, cleanup, create } = harness();
  const session = await create();
  try {
    session.dispose();
    assert.equal(session.active, false);
    // the same wait that saw the timeout land above
    await after(PAST_TIMEOUT_MS);
    assert.equal(calls.finished, 0);
    assert.deepEqual(calls.toasts, []);
  } finally {
    cleanup();
  }
});

test("completing before the timeout finishes the session exactly once", async () => {
  const { calls, cleanup, create } = harness();
  const session = await create();
  try {
    assert.equal(typeof session.complete(), "string");
    assert.equal(calls.finished, 1);
    await after(PAST_TIMEOUT_MS);
    // complete() -> ensureFrames() -> stopCapture() cancelled the timer, and the
    // completing/closed guards would stop it anyway
    assert.equal(calls.finished, 1);
    assert.equal(session.complete(), null);
    assert.equal(calls.finished, 1);
  } finally {
    session.dispose();
    cleanup();
  }
});

test("a manual stop into review disarms the auto-stop with the session still open", async () => {
  const { calls, cleanup, create } = harness();
  const session = await create();
  try {
    // what the record keybinding does on a live recording: actions.stop() -> stopReview()
    session.actions.stop();
    assert.equal(session.reviewing, true);
    assert.equal(session.active, true);
    await after(PAST_TIMEOUT_MS);
    // capture is stopped, so nothing grows on disk, but the review is not force-completed
    assert.equal(session.active, true);
    assert.equal(calls.finished, 0);
  } finally {
    session.dispose();
    cleanup();
  }
});

test("a recording with no frames is discarded instead of completed", async () => {
  const { calls, cleanup, create } = harness({ frames: [] });
  const session = await create();
  try {
    await after(PAST_TIMEOUT_MS);
    assert.deepEqual(calls.toasts, ["failed:Nothing captured"]);
    assert.equal(calls.finished, 1);
    assert.equal(session.active, false);
  } finally {
    session.dispose();
    cleanup();
  }
});

test("timeoutMs is opt-in: a recording started from the UI arms no timer", async () => {
  const { calls, cleanup, create } = harness();
  const session = await create({});
  try {
    assert.equal(session.agent, false);
    await after(PAST_TIMEOUT_MS);
    assert.equal(session.active, true);
    assert.equal(calls.finished, 0);
  } finally {
    session.dispose();
    cleanup();
  }
});
