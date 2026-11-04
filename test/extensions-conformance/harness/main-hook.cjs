// Test-only entry for the daemon: tb.mjs starts Electron on this file instead of browser/dist/main.js, so the
// harness can run code in the main process without the Node inspector, which release fuses turn off.
// Nothing in browser/ loads this file and scripts/release.sh checks that no release contains it.
//   electron main-hook.cjs --test-hook-socket=<path> --daemon
const path = require("node:path");

const MARKER = "terminal-browser-test-hook";
const REPO = path.resolve(__dirname, "../../..");
const dist = path.join(REPO, "browser/dist");
const fromBrowser = require("node:module").createRequire(path.join(REPO, "browser/package.json"));
const { listenPrivately, privateServer } = fromBrowser("@zenbu-labs/pixel/private-socket");

const socketPath = process.argv.find((arg) => arg.startsWith("--test-hook-socket="))?.slice("--test-hook-socket=".length);
if (!socketPath) {
  // fixme: placeholder copy
  process.stderr.write(`${MARKER}: --test-hook-socket=<path> is required\n`);
  process.exit(2);
}

const AsyncFunction = (async () => {}).constructor;

// One JSON request per line: { id, expression }, where expression is an async function body that can use
// `req` (require from browser/dist), `dist` and `svc` (the extension service). Replies { id, ok, value | error }.
async function evaluate(expression) {
  const req = fromBrowser;
  const svc = req(path.join(dist, "extensions/service.js")).extensionService();
  return new AsyncFunction("req", "dist", "svc", expression)(req, dist, svc);
}

const server = privateServer((connection) => {
  let buffered = "";
  connection.setEncoding("utf8");
  connection.on("error", () => {});
  connection.on("data", (chunk) => {
    buffered += chunk;
    for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        continue;
      }
      evaluate(String(request.expression)).then(
        (value) => connection.write(`${JSON.stringify({ id: request.id, ok: true, value })}\n`),
        (error) => connection.write(`${JSON.stringify({ id: request.id, ok: false, error: error instanceof Error ? error.stack : String(error) })}\n`),
      );
    }
  });
});
listenPrivately(server, socketPath);
server.unref();

// Holds back every layout measurement the engine reports, like a slow machine does, so a
// surface drawn before its anchor is measured stays on screen long enough to be seen.
const layoutDelay = Number(process.env.TB_TEST_LAYOUT_DELAY_MS);
if (layoutDelay > 0) {
  const pixelDir = path.dirname(fromBrowser.resolve("@zenbu-labs/pixel/package.json"));
  const registry = require(path.join(pixelDir, "dist/registry.js"));
  const Base = registry.ViewRegistry;
  registry.ViewRegistry = class extends Base {
    constructor(...args) {
      super(...args);
      const set = this.layout.set.bind(this.layout);
      this.layout.set = (snapshot) => setTimeout(() => set(snapshot), layoutDelay);
    }
  };
}

require(path.join(dist, "main.js"));
