// End-to-end check that the browser exposes CDP only through its private socket.
// Starts an isolated browser in a pseudo-terminal, then drives a test page with
// `terminal-browser action`. Needs a built tree and python3, and uses /tmp so socket
// paths stay under the 104-byte limit. Run with:
//   node cli/test/private-cdp.e2e.mjs
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "cli", "dist", "main.js");
const PAGE = `<!doctype html><title>Private CDP e2e</title>
<input id="name" placeholder="Your name"><button onclick="out.textContent='Hello, '+document.getElementById('name').value">Greet</button>
<p id="out"></p><a id="get" href="data:application/octet-stream,touch%20pwned%0A" download="payload.sh">Get</a><input type="file" id="file">`;
const PTY = `
import os, pty, sys
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
while True:
    try:
        if not os.read(fd, 65536): break
    except OSError:
        break
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function profile() {
  const root = fs.mkdtempSync("/tmp/e-");
  const agent =
    process.env.TERMINAL_BROWSER_AGENT ??
    execFileSync(path.join(ROOT, "scripts", "agent-browser.sh"), ["--path"], { encoding: "utf8" }).trim();
  const env = {
    ...process.env,
    HOME: path.join(root, "home"),
    TERM: "xterm-kitty",
    TERMINAL_BROWSER_AGENT: agent,
    TERMINAL_BROWSER_APPDATA: path.join(root, "appdata"),
    TERMINAL_BROWSER_INTEROP_DIR: path.join(root, "interop"),
  };
  fs.mkdirSync(env.HOME, { mode: 0o700 });
  for (const name of ["DATA", "STATE", "CACHE", "CONFIG"]) env[`XDG_${name}_HOME`] = path.join(root, name.toLowerCase());
  for (const name of ["XDG_RUNTIME_DIR", "TMUX", "KITTY_WINDOW_ID", "TERM_PROGRAM", "TERMINAL_BROWSER_TERMINAL_SOCKET"]) {
    delete env[name];
  }
  for (const name of Object.keys(env)) if (name.startsWith("AGENT_BROWSER_")) delete env[name];
  return { root, env, agent };
}

function cli(env, args, options = {}) {
  const result = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, encoding: "utf8", ...options });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function tcpListeners(pids) {
  if (pids.length === 0) return "";
  const result = spawnSync("lsof", ["-a", "-p", pids.join(","), "-iTCP", "-sTCP:LISTEN", "-nP"], { encoding: "utf8" });
  return result.stdout.trim();
}

function processTable() {
  return execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
}

function descendants(...roots) {
  const all = processTable();
  const found = roots.filter((pid) => pid > 0);
  for (let i = 0; i < found.length; i++) {
    for (const [child, parent] of all) if (parent === found[i] && !found.includes(child)) found.push(child);
  }
  return found;
}

function openDescriptors(pid) {
  const out = spawnSync("lsof", ["-a", "-p", String(pid), "-F", "f"], { encoding: "utf8" }).stdout;
  return out.split("\n").filter((line) => /^f\d+$/.test(line)).map((line) => Number(line.slice(1)));
}

function environmentOf(pid) {
  if (process.platform === "linux") return fs.readFileSync(`/proc/${pid}/environ`, "utf8");
  return spawnSync("ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout;
}

function commandOf(pid) {
  return spawnSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout;
}

// Kernel addresses of the Unix sockets a process holds on the given fds.
function unixSockets(pid, fds) {
  const args = ["-a", "-p", String(pid), "-U", "-F", "d"];
  if (fds) args.push("-d", fds);
  const out = spawnSync("lsof", args, { encoding: "utf8" }).stdout;
  return new Set(out.split("\n").filter((line) => line.startsWith("d")).map((line) => line.slice(1)));
}

test("CDP is only reachable through the private socket, and action still drives the page", async (t) => {
  const { root, env, agent } = profile();
  const server = http.createServer((request, response) => {
    if (request.url !== "/never-answers") response.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  // Folders of ours left loose by an older run or a umask 002 shell are taken back.
  const paths = JSON.parse(
    execFileSync(process.execPath, ["-e", 'const s = require("shared"); console.log(JSON.stringify([require("node:path").dirname(s.DAEMON_SOCKET), s.LOGS_DIR]))'], {
      cwd: path.join(ROOT, "cli"),
      env,
      encoding: "utf8",
    }),
  );
  const [appDir, logsDir] = paths;
  fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(appDir, 0o775);
  fs.chmodSync(logsDir, 0o755);
  const umask = process.umask(0o002);
  const terminal = spawn("python3", ["-I", "-c", PTY, process.execPath, CLI, "open", url], {
    env: { ...env, NODE_OPTIONS: "--max-old-space-size=4000" },
    stdio: "ignore",
  });
  process.umask(umask);
  let agentPidFile = null;
  let daemonPid = null;
  t.after(async () => {
    if (agentPidFile && fs.existsSync(agentPidFile)) {
      try {
        process.kill(Number(fs.readFileSync(agentPidFile, "utf8")));
      } catch {}
    }
    cli(env, ["shutdown"]);
    terminal.kill();
    server.closeAllConnections();
    server.close();
    for (let i = 0; daemonPid && i < 50; i++) {
      try {
        process.kill(daemonPid, 0);
      } catch {
        break;
      }
      await sleep(200);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  let browser = null;
  for (let i = 0; i < 100 && !browser; i++) {
    await sleep(300);
    const listing = cli(env, ["ls", "--all", "--json"]);
    if (listing.status !== 0) continue;
    browser = JSON.parse(listing.stdout).browsers.find((entry) =>
      entry.tabs.some((tab) => tab.url === url && tab.title === "Private CDP e2e" && tab.targetId),
    );
  }
  assert.ok(browser, "the browser registered under umask 002 with no XDG_RUNTIME_DIR");
  assert.equal(browser.cdpPort, undefined, "ls --json shows no debugging port unless one was asked for");
  daemonPid = browser.pid;
  assert.ok(browser.cdpSocket.startsWith(fs.realpathSync(env.XDG_STATE_HOME)), browser.cdpSocket);
  const agentDir = path.join(path.dirname(path.dirname(browser.cdpSocket)), "agent-browser");
  agentPidFile = path.join(agentDir, `terminal-browser-${browser.key}.pid`);
  const agentPid = () => (fs.existsSync(agentPidFile) ? Number(fs.readFileSync(agentPidFile, "utf8")) : 0);
  const watched = () => descendants(browser.pid, agentPid());

  assert.equal(tcpListeners(watched()), "", "the browser listens on no TCP port");
  process.kill(browser.pid, "SIGUSR1");
  await sleep(1000);
  assert.equal(tcpListeners(watched()), "", "SIGUSR1 opened no debugger");
  for (const pid of descendants(browser.pid).filter((pid) => /native-scroll-helper/.test(commandOf(pid)))) {
    assert.deepEqual(openDescriptors(pid).filter((fd) => fd > 2), [], "the scroll helper inherited descriptors");
  }
  for (const pid of descendants(browser.pid)) assert.doesNotMatch(commandOf(pid), /remote-debugging-port/);
  assert.equal(fs.statSync(appDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(logsDir).mode & 0o777, 0o700);
  assert.doesNotMatch(environmentOf(browser.pid), /NODE_OPTIONS/);
  assert.equal(fs.lstatSync(browser.cdpSocket).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(browser.cdpSocket)).mode & 0o777, 0o700);
  for (const socket of [browser.socket, path.join(path.dirname(path.dirname(browser.socket)), "daemon.sock")]) {
    assert.equal(fs.lstatSync(socket).mode & 0o777, 0o600, socket);
  }

  const pipe = unixSockets(browser.pid, "3,4,5");
  assert.equal(pipe.size, 2, "fds 3/4 and 5 hold the two ends of the debugging pipe");
  for (const pid of descendants(browser.pid).slice(1)) {
    for (const address of unixSockets(pid)) assert.ok(!pipe.has(address), `pid ${pid} inherited the debugging pipe`);
  }

  const action = (...args) => cli(env, ["action", "--browser", browser.key, "--", ...args]);
  const snapshot = action("snapshot", "-i");
  assert.equal(snapshot.status, 0, snapshot.stderr);
  const textbox = snapshot.stdout.match(/textbox "Your name" \[ref=(e\d+)\]/)?.[1];
  const button = snapshot.stdout.match(/button "Greet" \[ref=(e\d+)\]/)?.[1];
  assert.ok(textbox && button, snapshot.stdout);
  assert.equal(action("fill", `@${textbox}`, "Rob").status, 0);
  assert.equal(action("click", `@${button}`).status, 0);
  const greeting = action("eval", "document.getElementById('out').textContent", "--json");
  assert.equal(JSON.parse(greeting.stdout).data.result, "Hello, Rob");
  assert.equal(fs.statSync(agentDir).mode & 0o777, 0o700);

  const running = spawn(process.execPath, ["--no-warnings", CLI, "action", "--browser", browser.key, "--", "wait", "3000"], {
    env,
    stdio: "ignore",
  });
  const finished = new Promise((resolve) => running.on("exit", resolve));
  for (let i = 0; i < 5; i++) {
    await sleep(400);
    assert.equal(tcpListeners(watched()), "", "nothing listens on TCP while an action runs");
  }
  assert.equal(await finished, 0);

  // What an action carries (passwords in fill) is in no process's argv when sent with --stdin.
  const marker = `hunter2-${process.pid}`;
  const secret = spawn(process.execPath, ["--no-warnings", CLI, "action", "--browser", browser.key, "--stdin"], {
    env,
    stdio: ["pipe", "pipe", "ignore"],
  });
  secret.stdin.end(JSON.stringify(["eval", `new Promise((done) => setTimeout(() => done("${marker}".length), 2500))`]));
  const secretOutput = new Promise((resolve) => {
    let text = "";
    secret.stdout.on("data", (chunk) => (text += chunk));
    secret.on("exit", (code) => resolve({ code, text }));
  });
  for (let i = 0; i < 4; i++) {
    await sleep(500);
    const everything = execFileSync("ps", ["-axww", "-o", "command="], { encoding: "utf8" });
    assert.doesNotMatch(everything, new RegExp(marker), "the action's words showed up in a process list");
  }
  const secretResult = await secretOutput;
  assert.equal(secretResult.code, 0);
  assert.match(secretResult.text, new RegExp(String(marker.length)));

  // Files agent-browser writes land where the caller asked, relative to its working folder,
  // and other users can't read them.
  const work = path.join(root, "work");
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, "photo.txt"), "upload me");
  const fromWork = (...args) => cli(env, ["action", "--browser", browser.key, "--", ...args], { cwd: work });
  const privateFile = (name) => {
    const stat = fs.statSync(path.join(work, name));
    assert.ok(stat.size > 0, name);
    assert.equal(stat.mode & 0o077, 0, `${name} is readable by other users`);
  };
  if (spawnSync("ffmpeg", ["-version"]).status === 0) {
    assert.equal(fromWork("record", "start", "take.webm").status, 0);
    await sleep(1500);
    assert.equal(tcpListeners(watched()), "", "recording to a file opened a TCP listener");
    assert.equal(fromWork("record", "stop").status, 0);
    privateFile("take.webm");
  }
  const shot = fromWork("screenshot", "shot.png");
  assert.equal(shot.status, 0, shot.stderr);
  privateFile("shot.png");
  assert.equal(fromWork("state", "save", "state.json").status, 0);
  privateFile("state.json");
  const downloaded = fromWork("download", "#get", "got.sh");
  assert.equal(downloaded.status, 0, downloaded.stderr);
  assert.equal(fs.readFileSync(path.join(work, "got.sh"), "utf8"), "touch pwned\n");
  const uploaded = fromWork("upload", "#file", "photo.txt");
  assert.equal(uploaded.status, 0, uploaded.stderr);
  const picked = fromWork("eval", "document.getElementById('file').files[0].name", "--json");
  assert.equal(JSON.parse(picked.stdout).data.result, "photo.txt");

  // Config files and variables agent-browser would otherwise obey must not move it off the private socket.
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "agent-browser.json"), JSON.stringify({ cdp: "9", provider: "browserbase" }));
  fs.mkdirSync(path.join(env.HOME, ".agent-browser"));
  fs.writeFileSync(path.join(env.HOME, ".agent-browser", "config.json"), JSON.stringify({ cdp: "ws://127.0.0.1:9/devtools/browser/x" }));
  const hostile = {
    ...env,
    AGENT_BROWSER_CDP: "9222",
    AGENT_BROWSER_AUTO_CONNECT: "1",
    AGENT_BROWSER_ENGINE: "lightpanda",
    AGENT_BROWSER_CONFIG: path.join(project, "agent-browser.json"),
  };
  const title = cli(hostile, ["action", "--browser", browser.key, "--", "eval", "document.title", "--json"], { cwd: project });
  assert.equal(title.status, 0, title.stderr);
  assert.equal(JSON.parse(title.stdout).data.result, "Private CDP e2e");

  for (const flags of [["--color-scheme", "dark"], ["--user-agent", "x"], ["--config", "/dev/null"], ["-p", "safari"], ["--state", "x.json"]]) {
    const refused = action(...flags, "get", "url");
    assert.notEqual(refused.status, 0, flags.join(" "));
    assert.match(refused.stderr, /not available through terminal-browser action/, flags.join(" "));
  }

  // The same requests sent straight to the patched agent-browser, past the CLI's checks.
  const config = path.join(agentDir, "config.json");
  const direct = (...args) =>
    spawnSync(agent, ["--session", `terminal-browser-${browser.key}`, ...args, "get", "url"], {
      env: { ...env, AGENT_BROWSER_SOCKET_DIR: agentDir, AGENT_BROWSER_CONFIG: config },
      encoding: "utf8",
    });
  for (const flags of [
    ["--color-scheme", "dark"],
    ["--cdp", "9222"],
    ["--cdp", "ws://127.0.0.1:9/devtools/browser/x"],
    ["--engine", "lightpanda"],
    ["-p", "safari"],
    ["--auto-connect"],
  ]) {
    const result = direct(...flags);
    assert.notEqual(result.status, 0, `${flags.join(" ")}: ${result.stdout}`);
    assert.equal(tcpListeners(watched()), "", `${flags.join(" ")} opened a TCP listener`);
    for (const pid of watched()) assert.doesNotMatch(commandOf(pid), /remote-debugging-port/, flags.join(" "));
  }

  for (const refused of [["stream", "enable"], ["inspect"], ["plugin", "add", "x"], ["--max-output", "1", "connect", "ws+unix:/tmp/x.sock"], ["batch", "connect ws+unix:/tmp/x.sock"]]) {
    const result = action(...refused);
    assert.notEqual(result.status, 0, refused.join(" "));
    assert.match(result.stdout + result.stderr, /not available through terminal-browser action/, refused.join(" "));
  }
  const whole = (...args) =>
    spawnSync(agent, ["--session", `terminal-browser-${browser.key}`, "--cdp", `ws+unix:${browser.cdpSocket}`, ...args], {
      env: { ...env, AGENT_BROWSER_SOCKET_DIR: agentDir, AGENT_BROWSER_CONFIG: config },
      encoding: "utf8",
    });
  for (const args of [
    ["plugin", "add", "x"],
    ["install"],
    ["upgrade"],
    ["connect", "ws+unix:/tmp/x.sock"],
    ["batch", "eval 1", "connect ws+unix:/tmp/x.sock"],
    ["stream", "enable"],
    ["inspect"],
  ]) {
    const result = whole(...args);
    assert.notEqual(result.status, 0, args.join(" "));
    assert.match(result.stdout + result.stderr, /not available in terminal-browser builds/, args.join(" "));
  }
  const pinned = direct("--cdp", `ws+unix:${path.join(root, "other.sock")}`);
  assert.notEqual(pinned.status, 0);
  assert.match(spawnSync(agent, ["--version"], { encoding: "utf8" }).stdout, /terminal-browser private-cdp build/);
  const stock = path.join(root, "stock-agent-browser");
  fs.writeFileSync(stock, "#!/bin/sh\necho 'agent-browser 0.38.1'\n", { mode: 0o755 });
  const refusedStock = cli({ ...env, TERMINAL_BROWSER_AGENT: stock }, ["action", "--browser", browser.key, "--", "get", "url"]);
  assert.notEqual(refusedStock.status, 0);
  assert.match(refusedStock.stderr, /is not the agent-browser build terminal-browser ships/);
  const after = action("eval", "document.title", "--json");
  assert.equal(JSON.parse(after.stdout).data.result, "Private CDP e2e");
  assert.equal(tcpListeners(watched()), "");

  // terminal-browser-file: serves local files only to the browser itself and to local
  // documents, never to a page a website controls.
  fs.writeFileSync(path.join(env.HOME, "doc-secret.js"), 'window.DOC_LEAK = "DOC-SECRET-e2e";');
  const probe = `new Promise((done) => { const s = document.createElement("script"); s.src = "terminal-browser-file://x${path.join(env.HOME, "doc-secret.js")}"; s.onload = () => done(String(window.DOC_LEAK)); s.onerror = () => done("blocked"); document.head.append(s); })`;
  const probed = action("eval", probe, "--json");
  assert.equal(JSON.parse(probed.stdout).data.result, "blocked", "a web page loaded a local file");

  // A tab whose navigation never commits must not hold up listing tabs.
  const firstTab = browser.tabs.find((tab) => tab.url === url);
  const timed = (args) => {
    const started = Date.now();
    return { ...cli(env, args), elapsed: Date.now() - started };
  };
  const opened = timed(["action", "--browser", browser.key, "--", "tab", "new", `${url}never-answers`]);
  assert.equal(opened.status, 0, opened.stderr);
  assert.ok(opened.elapsed < 5000, `opening a tab that never loads took ${opened.elapsed}ms`);
  await sleep(1000);
  const listed = timed(["ls", "--all", "--json"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.ok(listed.elapsed < 5000, `ls took ${listed.elapsed}ms`);
  const listedTabs = JSON.parse(listed.stdout).browsers.find((entry) => entry.key === browser.key).tabs;
  const stuck = listedTabs.find((tab) => tab.url === `${url}never-answers`);
  assert.ok(stuck, JSON.stringify(listedTabs));
  assert.equal(typeof listedTabs.find((tab) => tab.id === firstTab.id).timeOrigin, "number", "a loaded tab still reports its document's timeOrigin");
  const closed = timed(["action", "--browser", browser.key, "--tab", String(firstTab.id), "--", "tab", "close", String(stuck.id)]);
  assert.equal(closed.status, 0, closed.stderr);
  assert.ok(closed.elapsed < 5000, `closing the stuck tab took ${closed.elapsed}ms`);

  // Shutdown must not wait on the debugging pipe while agent-browser is still attached.
  assert.equal(cli(env, ["shutdown"]).status, 0);
  let exited = false;
  for (let i = 0; i < 25 && !exited; i++) {
    await sleep(200);
    try {
      process.kill(browser.pid, 0);
    } catch {
      exited = true;
    }
  }
  assert.ok(exited, "the daemon exited after shutdown");
});

test("--remote-debugging-port serves CDP on exactly one loopback port, and action still uses the private socket", async (t) => {
  const { root, env } = profile();
  const server = http.createServer((_, response) => response.end(PAGE));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const terminal = spawn("python3", ["-I", "-c", PTY, process.execPath, CLI, "open", "--remote-debugging-port", url], { env, stdio: "ignore" });
  let browser = null;
  t.after(async () => {
    cli(env, ["shutdown"]);
    terminal.kill();
    server.close();
    for (let i = 0; browser && i < 50; i++) {
      try {
        process.kill(browser.pid, 0);
      } catch {
        break;
      }
      await sleep(200);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (let i = 0; i < 100 && !browser; i++) {
    await sleep(300);
    const listing = cli(env, ["ls", "--all", "--json"]);
    if (listing.status !== 0) continue;
    browser = JSON.parse(listing.stdout).browsers.find((entry) => entry.tabs.some((tab) => tab.url === url && tab.targetId));
  }
  assert.ok(browser, "the browser registered");
  assert.ok(Number.isInteger(browser.cdpPort) && browser.cdpPort > 0, `cdpPort ${browser.cdpPort}`);
  const version = await (await fetch(`http://127.0.0.1:${browser.cdpPort}/json/version`)).json();
  assert.match(version.webSocketDebuggerUrl, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//);

  const title = cli(env, ["action", "--browser", browser.key, "--", "eval", "document.title", "--json"]);
  assert.equal(JSON.parse(title.stdout).data.result, "Private CDP e2e");
  const agentDir = path.join(path.dirname(path.dirname(browser.cdpSocket)), "agent-browser");
  const agentPidFile = path.join(agentDir, `terminal-browser-${browser.key}.pid`);
  const agentPid = fs.existsSync(agentPidFile) ? Number(fs.readFileSync(agentPidFile, "utf8")) : 0;
  t.after(() => {
    try {
      if (agentPid) process.kill(agentPid);
    } catch {}
  });
  const addresses = new Set(
    tcpListeners(descendants(browser.pid, agentPid))
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/)[8])
      .filter(Boolean),
  );
  assert.deepEqual([...addresses], [`127.0.0.1:${browser.cdpPort}`]);
  assert.equal(tcpListeners([agentPid]), "", "agent-browser listens on no TCP port");
});
