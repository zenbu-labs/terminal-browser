const assert = require("node:assert/strict");
const { test } = require("node:test");

const { resolveOutputPaths } = require("../dist/output-paths.js");

const cwd = "/work/project";

test("a relative screenshot path is resolved against the caller's directory", () => {
  assert.deepEqual(resolveOutputPaths(["screenshot", "canvas.png"], cwd), [
    "screenshot",
    "/work/project/canvas.png",
  ]);
  assert.deepEqual(resolveOutputPaths(["screenshot", "./shots/a.png"], cwd), [
    "screenshot",
    "/work/project/shots/a.png",
  ]);
  assert.deepEqual(resolveOutputPaths(["screenshot", "../a.jpg"], cwd), ["screenshot", "/work/a.jpg"]);
});

test("the path after a screenshot selector is resolved and the selector is left alone", () => {
  assert.deepEqual(resolveOutputPaths(["screenshot", "@e3", "button"], cwd), [
    "screenshot",
    "@e3",
    "/work/project/button",
  ]);
  assert.deepEqual(resolveOutputPaths(["screenshot", ".hero"], cwd), ["screenshot", ".hero"]);
  assert.deepEqual(resolveOutputPaths(["screenshot", "#main"], cwd), ["screenshot", "#main"]);
  assert.deepEqual(resolveOutputPaths(["screenshot", "main"], cwd), ["screenshot", "main"]);
});

test("screenshot flags and their values are not mistaken for the path", () => {
  assert.deepEqual(
    resolveOutputPaths(["screenshot", "--full", "page.png", "--screenshot-format", "jpeg"], cwd),
    ["screenshot", "--full", "/work/project/page.png", "--screenshot-format", "jpeg"],
  );
  assert.deepEqual(resolveOutputPaths(["--json", "screenshot", "-f", "page.png"], cwd), [
    "--json",
    "screenshot",
    "-f",
    "/work/project/page.png",
  ]);
  assert.deepEqual(resolveOutputPaths(["screenshot", "--annotate", "true", "page.png"], cwd), [
    "screenshot",
    "--annotate",
    "true",
    "/work/project/page.png",
  ]);
});

test("a relative pdf path is resolved against the caller's directory", () => {
  assert.deepEqual(resolveOutputPaths(["pdf", "page.pdf"], cwd), ["pdf", "/work/project/page.pdf"]);
});

test("absolute and home relative paths pass through untouched", () => {
  assert.deepEqual(resolveOutputPaths(["screenshot", "/tmp/a.png"], cwd), ["screenshot", "/tmp/a.png"]);
  assert.deepEqual(resolveOutputPaths(["pdf", "~/page.pdf"], cwd), ["pdf", "~/page.pdf"]);
});

test("other commands and a screenshot without a path are not changed", () => {
  assert.deepEqual(resolveOutputPaths(["screenshot"], cwd), ["screenshot"]);
  assert.deepEqual(resolveOutputPaths(["click", "a.png"], cwd), ["click", "a.png"]);
  assert.deepEqual(resolveOutputPaths(["eval", "document.title"], cwd), ["eval", "document.title"]);
});
