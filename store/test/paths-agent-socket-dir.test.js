const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const DIST_INDEX = path.join(__dirname, "..", "dist", "index.js");

function agentSocketsDir(env) {
  const childEnv = { ...process.env, ...env };
  for (const key of Object.keys(childEnv)) {
    if (childEnv[key] === undefined) delete childEnv[key];
  }
  return execFileSync(process.execPath, ["-e", `console.log(require(${JSON.stringify(DIST_INDEX)}).AGENT_SOCKETS_DIR)`], {
    encoding: "utf8",
    env: childEnv,
  }).trim();
}

const MACOS_SOCKET_BUDGET = 103;
const SESSION_NAME_LENGTH = 24;

function socketPathLength(dir) {
  return dir.length + 1 + SESSION_NAME_LENGTH + ".sock".length;
}

test("agent socket dir stays within the macOS sun_path budget when the home directory is long", () => {
  const longHome = path.join(os.tmpdir(), `tb-long-home-${"x".repeat(120)}`);
  const dir = agentSocketsDir({ HOME: longHome, XDG_RUNTIME_DIR: undefined });
  assert.ok(
    socketPathLength(dir) <= MACOS_SOCKET_BUDGET,
    `socket path would be ${socketPathLength(dir)} bytes (max ${MACOS_SOCKET_BUDGET}): ${dir}`,
  );
});

test("agent socket dir still derives from XDG_RUNTIME_DIR when it is set", () => {
  const runtimeDir = path.join(os.tmpdir(), "tb-runtime");
  const dir = agentSocketsDir({ XDG_RUNTIME_DIR: runtimeDir });
  assert.ok(dir.startsWith(runtimeDir + path.sep), `expected dir under ${runtimeDir}, got ${dir}`);
});
