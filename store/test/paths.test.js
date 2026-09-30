const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { test } = require("node:test");

test("Nix upgrades retain browser data and the daemon address", () => {
  const roots = [
    "/nix/store/00000000000000000000000000000000-terminal-browser-unstable-old/lib/terminal-browser",
    "/nix/store/11111111111111111111111111111111-terminal-browser-unstable-new/lib/terminal-browser",
  ];
  const locations = roots.map((root) => JSON.parse(execFileSync(process.execPath, [
    "-e",
    'const p = require("./dist/paths.js"); console.log(JSON.stringify([p.DATA_DIR, p.DB_FILE, p.DAEMON_SOCKET]));',
  ], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, TERMINAL_BROWSER_DIST_ROOT: root },
    encoding: "utf8",
  })));
  assert.deepEqual(locations[0], locations[1]);
});
