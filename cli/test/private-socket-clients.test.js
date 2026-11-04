const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const ROOT = path.join(__dirname, "..", "..");
const SOURCES = ["browser/src", "cli/src", "pixel/packages/pixel/src", "shared/src"];
const NATIVE = ["pixel/engine/crates"];

// Sockets that belong to other programs (terminals, the dev reloader) or are
// checked by hand. Everything else must go through connectPrivately, which
// resolves the real path and checks the server's uid before sending anything.
const CLIENTS_ALLOWED = new Map([
  ["pixel/packages/pixel/src/host/private-socket.ts", "connectPrivately itself"],
  ["pixel/packages/pixel/src/terminal/terminals/herdr.ts", "herdr's own socket"],
  ["shared/src/terminal-socket.ts", "the terminal's own socket"],
  ["browser/src/session/session.tsx", "the dev reload socket from scripts/dev.mjs"],
]);

// Servers that are a privateServer, peer-checked by hand, or the password-protected ssh proxy.
const SERVERS_ALLOWED = new Map([
  ["pixel/packages/pixel/src/host/private-socket.ts", "privateServer itself"],
  ["pixel/packages/pixel/src/web/auth-proxy.ts", "the ssh proxy, password on every request"],
  ["cli/src/claude-bridge.ts", "HTTP on a private socket, peer uid checked on every connection"],
  ["browser/src/cdp/port.ts", "the opt-in --remote-debugging-port, loopback only and only when asked for"],
]);

function files(dir, pattern) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "target" ? [] : files(full, pattern);
    return pattern.test(entry.name) ? [full] : [];
  });
}

function sources() {
  return SOURCES.flatMap((source) => files(path.join(ROOT, source), /\.(ts|tsx)$/)).map((file) => ({
    relative: path.relative(ROOT, file),
    text: fs.readFileSync(file, "utf8"),
  }));
}

const CLIENT_CALL = /\b(net|tls)\.(connect|createConnection)\(|new (net\.)?Socket\(\)\.connect\(|\b(http|https)\.(request|get)\(\s*\{[\s\S]{0,400}?\bsocketPath\s*:/;
const SERVER_CALL = /\b(net|http|https|http2|tls)\.create(Secure)?Server\(|\.listen\(\s*\d/;
const DESTRUCTURED = /import\s*\{[^}]*\b(connect|createConnection|createServer|Socket|Server)\b[^}]*\}\s*from\s*["']node:(net|http|https|http2|tls)["']/;

test("Unix sockets of ours are only ever connected to through connectPrivately", () => {
  const offenders = sources()
    .filter(({ relative, text }) => !CLIENTS_ALLOWED.has(relative) && (CLIENT_CALL.test(text) || DESTRUCTURED.test(text)))
    .map(({ relative }) => relative);
  assert.deepEqual(offenders, [], `connect with connectPrivately instead: ${offenders.join(", ")}`);
});

test("every socket server of ours is a privateServer, peer-checked, or the password-protected ssh proxy", () => {
  const offenders = sources()
    .filter(({ relative, text }) => !SERVERS_ALLOWED.has(relative) && (SERVER_CALL.test(text) || DESTRUCTURED.test(text)))
    .map(({ relative }) => relative);
  assert.deepEqual(offenders, [], `serve with privateServer and listenPrivately instead: ${offenders.join(", ")}`);
});

test("the native engine connects only through connect_own, and listens nowhere", () => {
  const offenders = [];
  for (const file of NATIVE.flatMap((dir) => files(path.join(ROOT, dir), /\.rs$/))) {
    const relative = path.relative(ROOT, file);
    const text = fs.readFileSync(file, "utf8").split("#[cfg(test)]")[0];
    if (/UnixStream::connect\(/.test(text) && !relative.endsWith("own_socket.rs")) offenders.push(`${relative}: UnixStream::connect`);
    if (/(Unix|Tcp)Listener::bind\(|TcpStream::connect\(/.test(text)) offenders.push(`${relative}: listener or TCP`);
  }
  assert.deepEqual(offenders, []);
});
