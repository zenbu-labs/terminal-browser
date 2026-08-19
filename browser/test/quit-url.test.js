const assert = require("node:assert/strict");
const test = require("node:test");

const { EventEmitter } = require("node:events");
const {
  QUIT_URL,
  QuitUrlPolicy,
  registerQuitUrlNavigationHandlers,
} = require("../dist/page/quit-url.js");

const PRIMARY = 11;

test("quit URL recognition is literal equality at the Electron event boundary", () => {
  const policy = new QuitUrlPolicy(true, PRIMARY);
  const variants = [
    "terminal-browser://quitter",
    "terminal-browser://QUIT",
    "terminal-browser://qu%69t",
    "terminal-browser://quit/",
    "terminal-browser://quit/path",
    "terminal-browser://quit?now",
    "terminal-browser://quit#now",
  ];

  for (const url of variants) {
    assert.equal(policy.request(url, PRIMARY, "navigation", PRIMARY), "ignore", url);
  }
});

test("default-off consumes exact navigation and window-open without closing", () => {
  for (const kind of ["navigation", "window-open"]) {
    const policy = new QuitUrlPolicy(false, PRIMARY);
    assert.equal(policy.request(QUIT_URL, PRIMARY, kind), "consume");
  }
});

test("default-off remains closed for requests from frames in the primary WebContents", () => {
  for (const kind of ["navigation", "window-open"]) {
    const policy = new QuitUrlPolicy(false, PRIMARY);
    assert.equal(policy.request(QUIT_URL, PRIMARY, kind), "consume");
  }
});

test("opt-in primary WebContents authorizes direct navigation and window-open", () => {
  const policy = new QuitUrlPolicy(true, PRIMARY);
  assert.equal(policy.request(QUIT_URL, PRIMARY, "navigation", PRIMARY), "close");
  assert.equal(policy.request(QUIT_URL, PRIMARY, "window-open"), "close");
});

test("frames in the primary WebContents share the capability", () => {
  const policy = new QuitUrlPolicy(true, PRIMARY);
  assert.equal(policy.request(QUIT_URL, PRIMARY, "navigation", PRIMARY), "close");

  const windowOpenPolicy = new QuitUrlPolicy(true, PRIMARY);
  assert.equal(windowOpenPolicy.request(QUIT_URL, PRIMARY, "window-open"), "close");
});

test("popup, nested popup, and foreign WebContents are denied", () => {
  for (const requester of [12, 13, 99]) {
    const policy = new QuitUrlPolicy(true, PRIMARY);
    assert.equal(policy.request(QUIT_URL, requester, "navigation", requester), "consume");
  }
});

test("navigation requires target and initiator ownership", () => {
  const policy = new QuitUrlPolicy(true, PRIMARY);
  assert.equal(policy.request(QUIT_URL, PRIMARY, "navigation", 12), "consume");
  assert.equal(policy.request(QUIT_URL, PRIMARY, "navigation"), "consume");
  assert.equal(policy.request(QUIT_URL, undefined, "navigation", PRIMARY), "consume");
});

test("server redirects are consumed regardless of capability", () => {
  for (const allowed of [false, true]) {
    const policy = new QuitUrlPolicy(allowed, PRIMARY);
    assert.equal(policy.request(QUIT_URL, PRIMARY, "redirect"), "consume");
    assert.equal(policy.request(QUIT_URL, 12, "redirect"), "consume");
  }
});

test("authorized requests remain retriable after a close veto", () => {
  const policy = new QuitUrlPolicy(true, PRIMARY);
  assert.equal(policy.request(QUIT_URL, PRIMARY, "navigation", PRIMARY), "close");
  assert.equal(policy.request(QUIT_URL, PRIMARY, "window-open"), "close");
});

test("navigation wiring covers every frame and keeps redirects distinct", () => {
  const contents = new EventEmitter();
  const requests = [];
  const targetFrame = { detached: false, isDestroyed: () => false };
  const initiatorFrame = { detached: false, isDestroyed: () => false };
  const target = { id: PRIMARY, isDestroyed: () => false };
  const initiator = { id: PRIMARY, isDestroyed: () => false };
  registerQuitUrlNavigationHandlers(
    contents,
    (frame) => new Map([[targetFrame, target], [initiatorFrame, initiator]]).get(frame),
    (url, request, targetContentsId, initiatorContentsId) => {
      requests.push({ url, request, targetContentsId, initiatorContentsId });
      return url === QUIT_URL;
    },
  );

  let navigationPrevented = 0;
  contents.emit("will-frame-navigate", {
    url: QUIT_URL,
    isMainFrame: true,
    frame: targetFrame,
    initiator: initiatorFrame,
    preventDefault: () => navigationPrevented++,
  });
  let redirectPrevented = 0;
  contents.emit("will-redirect", {
    url: QUIT_URL,
    frame: targetFrame,
    initiator: initiatorFrame,
    preventDefault: () => redirectPrevented++,
  });

  assert.deepEqual(requests, [
    {
      url: QUIT_URL,
      request: "navigation",
      targetContentsId: PRIMARY,
      initiatorContentsId: PRIMARY,
    },
    {
      url: QUIT_URL,
      request: "redirect",
      targetContentsId: PRIMARY,
      initiatorContentsId: PRIMARY,
    },
  ]);
  assert.equal(navigationPrevented, 1);
  assert.equal(redirectPrevented, 1);
  assert.equal(contents.listenerCount("will-navigate"), 0);
});

test("navigation wiring fails closed for unavailable frame provenance", () => {
  const contents = new EventEmitter();
  const policy = new QuitUrlPolicy(true, PRIMARY);
  const activeFrame = { detached: false, isDestroyed: () => false };
  const detachedFrame = { detached: true, isDestroyed: () => false };
  const destroyedFrame = { detached: false, isDestroyed: () => true };
  const unresolvedFrame = { detached: false, isDestroyed: () => false };
  const throwingFrame = { detached: false, isDestroyed: () => false };
  const destroyedContentsFrame = { detached: false, isDestroyed: () => false };
  const activeContents = { id: PRIMARY, isDestroyed: () => false };
  const destroyedContents = { id: PRIMARY, isDestroyed: () => true };
  const actions = [];
  const resolved = new Map([
    [activeFrame, activeContents],
    [detachedFrame, activeContents],
    [destroyedFrame, activeContents],
    [destroyedContentsFrame, destroyedContents],
  ]);
  registerQuitUrlNavigationHandlers(
    contents,
    (frame) => {
      if (frame === throwingFrame) throw new Error("frame detached during lookup");
      return resolved.get(frame);
    },
    (url, request, targetContentsId, initiatorContentsId) => {
      const action = policy.request(url, targetContentsId, request, initiatorContentsId);
      actions.push(action);
      return action !== "ignore";
    },
  );

  for (const [frame, initiator] of [
    [null, activeFrame],
    [activeFrame, null],
    [detachedFrame, activeFrame],
    [activeFrame, destroyedFrame],
    [unresolvedFrame, activeFrame],
    [throwingFrame, activeFrame],
    [destroyedContentsFrame, activeFrame],
  ]) {
    contents.emit("will-frame-navigate", {
      url: QUIT_URL,
      frame,
      initiator,
      preventDefault() {},
    });
  }

  assert.deepEqual(actions, Array(7).fill("consume"));
});
