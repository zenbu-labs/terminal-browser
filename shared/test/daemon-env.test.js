const assert = require("node:assert/strict");
const { test } = require("node:test");

const { daemonEnv } = require("../dist/index.js");

test("an empty WAYLAND_DISPLAY is dropped so Electron does not pick Wayland", () => {
  const env = daemonEnv({ DISPLAY: ":0", WAYLAND_DISPLAY: "" });
  assert.equal("WAYLAND_DISPLAY" in env, false);
  assert.equal(env.DISPLAY, ":0");
});

test("a real WAYLAND_DISPLAY is kept", () => {
  assert.equal(daemonEnv({ WAYLAND_DISPLAY: "wayland-0" }).WAYLAND_DISPLAY, "wayland-0");
});

test("PIXEL_ variables are dropped and NODE_ENV defaults to production", () => {
  const env = daemonEnv({ PIXEL_TTY: "/dev/pts/1", HOME: "/home/a" });
  assert.equal("PIXEL_TTY" in env, false);
  assert.equal(env.HOME, "/home/a");
  assert.equal(env.NODE_ENV, "production");
  assert.equal(daemonEnv({ NODE_ENV: "development" }).NODE_ENV, "development");
});
