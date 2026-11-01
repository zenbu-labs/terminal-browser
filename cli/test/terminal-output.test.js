const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "tb-cli-hostile-"));
const env = {
  PATH: process.env.PATH,
  HOME: home,
  TERM: "dumb",
  PIXEL_SKIP_GRAPHICS_CHECK: "1",
  XDG_DATA_HOME: path.join(home, "data"),
  XDG_STATE_HOME: path.join(home, "state"),
  XDG_CACHE_HOME: path.join(home, "cache"),
  XDG_CONFIG_HOME: path.join(home, "config"),
  XDG_RUNTIME_DIR: path.join(home, "run"),
};
for (const key of Object.keys(process.env)) {
  if (/^(TMUX|TERM_PROGRAM|KITTY_|WEZTERM_|ITERM_|CMUX_|HERDR_|SUPACODE_|GHOSTTY_|REX_|TERMINAL_BROWSER_|VSCODE_)/.test(key)) delete process.env[key];
}
Object.assign(process.env, env);
const { CDP_SOCKET, ensurePrivateDir, upsertInstance } = require("shared");
const { oneLine, printable, safeJson, safeJsonText } = require("../dist/output.js");

const ESC = "\x1b";
const HOSTILE = [
  "Pwn",
  `${ESC}]0;retitled${"\x07"}`,
  `${ESC}]52;c;aGFybWxlc3M=${"\x07"}`,
  `${ESC}]8;;https://evil.example${ESC}\\link${ESC}]8;;${ESC}\\`,
  `${ESC}[2J${ESC}[H${ESC}[5A`,
  "\u009b2J",
  `${ESC}P+q544e${ESC}\\${ESC}_apc${ESC}\\${ESC}^pm${ESC}\\${ESC}Xsos${ESC}\\`,
  `${ESC}[200~rm -rf ~${ESC}[201~`,
  "\x07\x7f\x00\x08\r\n\t",
  "\u202eevil\u202c\u2066x\u2069\u200e\u200f\u061c",
  "end",
].join("");
const HOSTILE_URL = `http://127.0.0.1:1/${ESC}]0;url${"\x07"}\u202epath\u009b`;
const RAW_C1_BYTE = Buffer.from([0x9b]);
const PAGE_TEXT = Buffer.concat([Buffer.from("page text "), RAW_C1_BYTE, Buffer.from("2J "), Buffer.from(HOSTILE)]);

const DANGEROUS = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const DANGEROUS_IN_A_FIELD = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

function assertTerminalSafe(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    assert.fail(`${label} wrote bytes that are not UTF-8 (a raw C1 control like 0x9b)`);
  }
  const found = DANGEROUS.exec(text);
  assert.equal(found, null, `${label} wrote a raw U+${found?.[0].charCodeAt(0).toString(16).padStart(4, "0")}: ${JSON.stringify(text)}`);
  return text;
}

const socketPath = path.join(home, "c.sock");
const controlRequests = [];
let controlReply = () => ({});

function startControl() {
  const server = net.createServer((connection) => {
    let buffer = "";
    connection.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      controlRequests.push(request);
      const answer = controlReply(request);
      const line = answer.error
        ? JSON.stringify({ id: request.id, ok: false, error: answer.error })
        : JSON.stringify({ id: request.id, ok: true, data: answer.data ?? {} });
      connection.end(`${line}\n`);
    });
  });
  return new Promise((resolve) => server.listen(socketPath, () => resolve(server)));
}

const TAB = { id: 7, url: HOSTILE_URL, title: HOSTILE, active: true, targetId: "T1", app: null, timeOrigin: null };

function defaultReply(request) {
  if (request.cmd === "where") return { data: { terminal: null, tab: null, pane: null } };
  if (request.cmd === "targets") return { data: { tabs: [TAB] } };
  if (request.cmd === "agent-release") return { data: { released: HOSTILE } };
  if (request.cmd === "open-tab") return { data: { openedTab: 8, title: HOSTILE } };
  if (request.cmd === "clear-browsing-data") return { data: { cleared: ["history", HOSTILE] } };
  if (request.cmd === "agent-touch") return { data: {} };
  return { error: `unknown ${request.cmd}` };
}

const fakeAgent = path.join(home, "agent-browser");
fs.writeFileSync(
  fakeAgent,
  `#!${process.execPath}
if (process.argv[2] === "--version") {
  process.stdout.write("agent-browser 0.0.0 (terminal-browser private-cdp build)\\n");
  process.exit(0);
}
const words = process.env.AGENT_BROWSER_ARGS_FD ? JSON.parse(require("node:fs").readFileSync(Number(process.env.AGENT_BROWSER_ARGS_FD), "utf8")) : process.argv.slice(2);
const args = words.filter((arg, at, all) => arg !== "--session" && all[at - 1] !== "--session" && arg !== "--cdp" && all[at - 1] !== "--cdp");
const hostile = ${JSON.stringify(HOSTILE)};
const page = Buffer.from(${JSON.stringify(PAGE_TEXT.toString("base64"))}, "base64");
if (args[0] === "tab" && args[1] === "list") {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [{ tabId: "t1", url: ${JSON.stringify(HOSTILE_URL)}, title: hostile, active: true }] } }));
} else if (args.includes("--json")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: hostile } }) + "\\n");
} else if (args[0] === "click") {
  process.stderr.write(Buffer.concat([Buffer.from("error on "), page, Buffer.from("\\n")]));
  process.exit(1);
} else {
  process.stdout.write(Buffer.concat([page, Buffer.from("\\n")]));
}
`,
  { mode: 0o755 },
);

function cli(...args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(__dirname, "../dist/main.js"), ...args],
      { env: { ...env, TERMINAL_BROWSER_AGENT: fakeAgent }, encoding: "buffer", timeout: 20_000 },
      (error, stdout, stderr) => resolve({ status: error ? error.code ?? 1 : 0, stdout, stderr }),
    );
  });
}

let server;
before(async () => {
  server = await startControl();
  fs.writeFileSync(path.join(ensurePrivateDir(path.dirname(CDP_SOCKET)), path.basename(CDP_SOCKET)), "");
  controlReply = defaultReply;
  await upsertInstance({
    key: "evil",
    pid: process.pid,
    socket: socketPath,
    cdpPort: 1,
    url: HOSTILE_URL,
    title: HOSTILE,
    startedAt: 1,
  });
});

after(() => {
  server?.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test("text escapes show every control character instead of acting on it", () => {
  assert.equal(oneLine("a\x1b[2Jb\u009bc\u202ed\ne\tf\x07\x7f"), "a\\e[2Jb\\u009bc\\u202ed\\ne\\tf\\x07\\x7f");
  assert.equal(printable("a\nb\tc\rd\x1b"), "a\nb\tc\\rd\\e");
  assert.doesNotMatch(oneLine(HOSTILE), DANGEROUS_IN_A_FIELD);
  assert.doesNotMatch(printable(HOSTILE), DANGEROUS);
});

test("JSON output escapes what JSON.stringify leaves raw and round-trips", () => {
  const value = { title: HOSTILE, url: HOSTILE_URL };
  for (const indent of [0, 2]) {
    const text = safeJson(value, indent);
    assert.doesNotMatch(text, DANGEROUS);
    assert.deepEqual(JSON.parse(text), value);
  }
  assert.deepEqual(JSON.parse(safeJsonText(JSON.stringify(value))), value);
});

test("ls prints hostile titles and URLs as visible escapes, one line each", async () => {
  const result = await cli("ls", "--all");
  assert.equal(result.status, 0, result.stderr.toString());
  const text = assertTerminalSafe(result.stdout, "ls");
  assertTerminalSafe(result.stderr, "ls stderr");
  assert.match(text, /Pwn\\e\]0;retitled\\x07\\e\]52;c;aGFybWxlc3M=\\x07/);
  assert.match(text, /\\u009b2J/);
  assert.match(text, /\\u202eevil/);
  assert.equal(text.trimEnd().split("\n").length, 4);
});

test("ls --json is valid JSON that round-trips the hostile strings", async () => {
  const result = await cli("ls", "--all", "--json");
  assert.equal(result.status, 0, result.stderr.toString());
  const text = assertTerminalSafe(result.stdout, "ls --json");
  const tab = JSON.parse(text).browsers[0].tabs[0];
  assert.equal(tab.title, HOSTILE);
  assert.equal(tab.url, HOSTILE_URL);
});

test("action relays page text, eval results and errors as visible escapes", async () => {
  const snapshot = await cli("action", "--browser", "evil", "--", "get", "text", "body");
  assert.equal(snapshot.status, 0, snapshot.stderr.toString());
  const text = assertTerminalSafe(snapshot.stdout, "action get text");
  assert.match(text, /page text \ufffd2J Pwn\\e\]0;retitled/);
  assertTerminalSafe(snapshot.stderr, "action get text stderr");

  const failed = await cli("action", "--browser", "evil", "--", "click", "@e1");
  assert.equal(failed.status, 1);
  assert.match(assertTerminalSafe(failed.stderr, "action error"), /error on page text/);
});

test("action --json stays valid JSON that round-trips the page's strings", async () => {
  const result = await cli("action", "--browser", "evil", "--", "eval", "document.title", "--json");
  assert.equal(result.status, 0, result.stderr.toString());
  const text = assertTerminalSafe(result.stdout, "action --json");
  assert.equal(JSON.parse(text).data.result, HOSTILE);
});

test("action replies the CLI answers itself are escaped too", async () => {
  for (const args of [["done"], ["--", "open", "https://example.com"], ["--", "tab", "new"]]) {
    const result = await cli("action", "--browser", "evil", ...args);
    assert.equal(result.status, 0, result.stderr.toString());
    const text = assertTerminalSafe(result.stdout, `action ${args.join(" ")}`);
    assert.match(text, /Pwn/);
    JSON.parse(text);
  }
});

test("errors that echo a browser's URL are escaped", async () => {
  const result = await cli("action", "--browser", "nope", "--", "snapshot");
  assert.notEqual(result.status, 0);
  const text = assertTerminalSafe(result.stderr, "action error");
  assert.match(text, /\\e\]0;url\\x07\\u202epath\\u009b/);
});

test("new-tab and clear-browsing-data echo daemon replies escaped", async () => {
  const cleared = await cli("clear-browsing-data", "--browser", "evil", "--yes");
  assert.equal(cleared.status, 0, cleared.stderr.toString());
  assert.match(assertTerminalSafe(cleared.stdout, "clear-browsing-data"), /cleared browsing history, and Pwn\\e/);

  controlReply = (request) => (request.cmd === "open-tab" ? { error: `refused ${HOSTILE}` } : defaultReply(request));
  try {
    const refused = await cli("new-tab", "--browser", "evil", "https://example.com");
    assert.notEqual(refused.status, 0);
    assert.match(assertTerminalSafe(refused.stderr, "new-tab error"), /refused Pwn\\e/);
  } finally {
    controlReply = defaultReply;
  }
});

test("no CLI file writes to stdout or stderr except through the output module", () => {
  const dir = path.join(__dirname, "../src");
  for (const file of fs.readdirSync(dir)) {
    if (file === "output.ts") continue;
    const source = fs.readFileSync(path.join(dir, file), "utf8");
    assert.doesNotMatch(source, /process\.std(out|err)\.write|console\.(log|error|warn|info)/, file);
  }
});
