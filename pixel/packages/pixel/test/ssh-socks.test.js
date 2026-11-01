const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { startAuthProxy } = require("../dist/web/auth-proxy.js");
const { spawnSync } = require("node:child_process");
const { openSshTunnel, parseSshProxyRules, sshForward, sshMasterArgs, sshProxyRules, userSshConfig, validateSshTarget } = require("../dist/ssh/index.js");

function scratch(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pixel-socks-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// Stands in for `ssh -W host:port`: a direct connection from this machine.
const direct = (host, port) => net.connect(port, host);

function site(t) {
  const server = http.createServer((request, response) => response.end(`remote saw ${request.url}`));
  t.after(() => server.close());
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function proxyRequest(port, lines, { untilHead = false } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let reply = "";
    socket.on("connect", () => socket.write(lines.join("\r\n") + "\r\n\r\n"));
    socket.on("data", (chunk) => {
      reply += chunk;
      if (untilHead && reply.includes("\r\n\r\n")) socket.destroy();
    });
    socket.on("error", () => {});
    socket.on("close", () => resolve(reply));
  });
}

function fakeSsh(t, script) {
  const bin = scratch(t);
  const log = path.join(bin, "calls.jsonl");
  fs.writeFileSync(
    path.join(bin, "ssh"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
${script}
`,
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  const previousRuntime = process.env.XDG_RUNTIME_DIR;
  process.env.PATH = `${bin}:${previousPath}`;
  process.env.XDG_RUNTIME_DIR = path.join(bin, "run");
  t.after(() => {
    process.env.PATH = previousPath;
    if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntime;
  });
  return { bin, calls: () => fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) };
}

test("the loopback proxy answers only requests that carry its password", async (t) => {
  const sitePort = await site(t);
  const proxy = await startAuthProxy(direct);
  t.after(() => proxy.close());
  const target = `GET http://127.0.0.1:${sitePort}/secret HTTP/1.1`;
  const host = `Host: 127.0.0.1:${sitePort}`;
  assert.match(await proxyRequest(proxy.port, [target, host]), /^HTTP\/1.1 407/);
  const wrong = `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:nope`).toString("base64")}`;
  assert.match(await proxyRequest(proxy.port, [target, host, wrong]), /^HTTP\/1.1 407/);
  const right = `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}`;
  const reply = await proxyRequest(proxy.port, [target, host, right]);
  assert.match(reply, /^HTTP\/1.1 200/);
  assert.match(reply, /remote saw \/secret/);
  const tunnel = await proxyRequest(proxy.port, [`CONNECT 127.0.0.1:${sitePort} HTTP/1.1`, right], { untilHead: true });
  assert.match(tunnel, /^HTTP\/1.1 200 Connection Established/);
});

test("the loopback proxy drops a connection that never finishes its request, and caps connections", async (t) => {
  const proxy = await startAuthProxy(direct, { headTimeoutMs: 200, maxConnections: 4 });
  t.after(() => proxy.close());
  const idle = net.connect(proxy.port, "127.0.0.1");
  idle.on("error", () => {});
  const started = Date.now();
  await new Promise((resolve) => idle.on("close", resolve));
  assert.ok(Date.now() - started < 2000);
  const extra = [];
  for (let i = 0; i < 8; i++) {
    const socket = net.connect(proxy.port, "127.0.0.1");
    socket.on("error", () => {});
    extra.push(new Promise((resolve) => socket.on("close", () => resolve(true))));
  }
  const early = await Promise.all(extra.map((done) => Promise.race([done, new Promise((r) => setTimeout(() => r(false), 100))])));
  assert.ok(early.filter(Boolean).length >= 4, `only ${early.filter(Boolean).length} of 8 over-cap connections were turned away`);
});

test("ssh opens no forwards: the master clears them all, and pages reach the remote side through ssh -W", async (t) => {
  const { calls } = fakeSsh(t, "process.exit(0);");
  const tunnel = await openSshTunnel("example-host", () => {}, { terminal: false });
  const master = calls().find((args) => args.includes("-M"));
  assert.equal(master[0], "-F");
  assert.deepEqual(master.slice(2, 4), ["-o", "ClearAllForwardings=yes"]);
  assert.ok(master.includes("StrictHostKeyChecking=yes"));
  assert.deepEqual(master.slice(-2), ["--", "example-host"]);
  for (const args of calls()) for (const flag of ["-D", "-L", "-R"]) assert.ok(!args.includes(flag), `${flag} in ${args.join(" ")}`);
  assert.doesNotMatch(calls().flat().join(" "), /127\.0\.0\.1|localhost/);
  const dir = path.dirname(tunnel.controlPath);
  assert.ok(dir.startsWith(fs.realpathSync(path.join(process.env.XDG_RUNTIME_DIR, "pixel", "ssh"))));
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.dirname(dir)).mode & 0o777, 0o700);
  assert.deepEqual(parseSshProxyRules(sshProxyRules(tunnel)), { controlPath: tunnel.controlPath, destination: "example-host" });
  tunnel.stop();
  assert.equal(fs.existsSync(dir), false);
});

async function echoOnce(stream) {
  const reply = new Promise((resolve) => stream.once("data", (chunk) => resolve(chunk.toString())));
  stream.write("ping");
  const text = await reply;
  stream.destroy();
  return text;
}

test("each forwarded connection is ssh -W through the control socket, with no config and a checked host", async (t) => {
  const { calls } = fakeSsh(t, "process.stdin.pipe(process.stdout);");
  const route = { controlPath: "/private/control", destination: "example-host" };
  assert.equal(await echoOnce(sshForward(route, "intranet.example", 8080)), "ping");
  assert.equal(await echoOnce(sshForward(route, "::1", 80)), "ping");
  const noConfig = ["-F", "/dev/null", "-o", "ProxyCommand=false", "-o", "BatchMode=yes", "-o", "ControlMaster=no"];
  assert.deepEqual(calls()[0], [...noConfig, "-S", "/private/control", "-W", "intranet.example:8080", "--", "example-host"]);
  assert.deepEqual(calls()[1], [...noConfig, "-S", "/private/control", "-W", "[::1]:80", "--", "example-host"]);
  for (const host of ["-oProxyCommand=touch /tmp/x", "a b", "a\nb", ""]) {
    assert.throws(() => sshForward(route, host, 80), /invalid destination/, JSON.stringify(host));
  }
});

test("the master clears config forwards and keeps host-key checking on whatever the config says", (t) => {
  const config = path.join(scratch(t), "config");
  fs.writeFileSync(
    config,
    "Host review-host\n  DynamicForward 127.0.0.1:1081\n  LocalForward 127.0.0.1:1082 localhost:80\n  RemoteForward 1083 localhost:80\n  StrictHostKeyChecking no\n  ClearAllForwardings no\n",
  );
  const effective = spawnSync("ssh", ["-G", ...sshMasterArgs("/tmp/control", [], "review-host", false, config)], { encoding: "utf8" }).stdout;
  assert.match(effective, /^clearallforwardings yes$/m);
  assert.match(effective, /^stricthostkeychecking true$/m);
  assert.doesNotMatch(effective, /^(dynamic|local|remote)forward /m);
});

test("the --ssh target is only ever [user@]host[:port]", () => {
  for (const target of ["host", "dev@build-box", "dev@build-box:2222", "10.0.0.5", "my_host.local"]) validateSshTarget(target);
  for (const target of [
    "ssh -oProxyCommand=/tmp/x host",
    "-oProxyCommand=/tmp/x",
    "-F",
    "host -F ./untrusted.conf",
    "ssh -oStrictHostKeyChecking=no host",
    "ssh -S /tmp/other host",
    "a b",
    "host%h",
    "user@-oProxyCommand=x",
    "-host",
    "host\n",
    "host\t",
    "host:0",
    "host:99999",
    "user@host:22:33",
    "",
  ]) {
    assert.throws(() => validateSshTarget(target), /invalid ssh target/, JSON.stringify(target));
  }
});

test("only the user's own ~/.ssh/config is read, and only when nobody else could have written it", (t) => {
  const home = scratch(t);
  assert.equal(userSshConfig(home), "/dev/null");
  fs.mkdirSync(path.join(home, ".ssh"));
  const config = path.join(home, ".ssh", "config");
  fs.writeFileSync(config, "Host x\n", { mode: 0o600 });
  assert.equal(userSshConfig(home), config);
  fs.chmodSync(config, 0o664);
  assert.equal(userSshConfig(home), "/dev/null");
  fs.chmodSync(config, 0o600);
  assert.equal(userSshConfig(home, process.getuid() + 1), "/dev/null");
});

test("every request on a kept-alive connection is checked, and the password never reaches the remote side", async (t) => {
  const seen = [];
  const remote = http.createServer((request, response) => {
    seen.push(request.rawHeaders.join("\n").toLowerCase());
    response.writeHead(200, { connection: "keep-alive", "content-length": 2 }).end("ok");
  });
  await new Promise((resolve) => remote.listen(0, "127.0.0.1", resolve));
  t.after(() => remote.close());
  const port = remote.address().port;
  const proxy = await startAuthProxy(direct);
  t.after(() => proxy.close());
  const right = `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}`;
  const ask = (pathname, auth) =>
    [`GET http://127.0.0.1:${port}${pathname} HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Connection: keep-alive", ...(auth ? [auth] : [])].join("\r\n") + "\r\n\r\n";
  const socket = net.connect(proxy.port, "127.0.0.1");
  let replies = "";
  socket.on("data", (chunk) => (replies += chunk));
  await new Promise((resolve) => socket.on("connect", resolve));
  socket.write(ask("/first", right));
  await new Promise((resolve) => setTimeout(resolve, 200));
  socket.write(ask("/second", right));
  await new Promise((resolve) => setTimeout(resolve, 200));
  socket.write(ask("/third", null));
  await new Promise((resolve) => setTimeout(resolve, 300));
  socket.destroy();
  assert.equal(seen.length, 2);
  for (const headers of seen) assert.doesNotMatch(headers, /proxy-authorization|terminal-browser:/);
  assert.equal((replies.match(/HTTP\/1.1 200/g) ?? []).length, 2);
  assert.match(replies, /HTTP\/1.1 407/);
});

test("once its ssh connection is gone the proxy keeps its port and answers 502 for good", async (t) => {
  const { sshProxyFor, runningSshProxy } = require("../dist/web/ssh-proxies.js");
  const dir = scratch(t);
  const controlPath = path.join(dir, "control");
  fs.writeFileSync(controlPath, "");
  const proxy = await sshProxyFor({ controlPath, destination: "example-host" }, direct, 50);
  t.after(() => proxy.close());
  const right = `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}`;
  fs.rmSync(controlPath);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(runningSshProxy(proxy.port), undefined, "its password is no longer handed out");
  const answer = await proxyRequest(proxy.port, ["GET http://127.0.0.1:9/ HTTP/1.1", "Host: 127.0.0.1:9", right]);
  assert.match(answer, /^HTTP\/1.1 502/);
  const squat = net.createServer();
  const bind = await new Promise((resolve) => {
    squat.once("error", (error) => resolve(error.code));
    squat.listen(proxy.port, "127.0.0.1", () => resolve("bound"));
  });
  squat.close();
  assert.equal(bind, "EADDRINUSE", "nobody else can take the port, even with no tab left");
});

test("a request made after the ssh connection is gone retires the proxy at once, without running ssh", async (t) => {
  const { sshProxyFor, runningSshProxy } = require("../dist/web/ssh-proxies.js");
  const controlPath = path.join(scratch(t), "control");
  fs.writeFileSync(controlPath, "");
  let opened = 0;
  const proxy = await sshProxyFor({ controlPath, destination: "gone-host" }, (...args) => (opened++, direct(...args)), 60_000);
  t.after(() => proxy.close());
  const right = `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}`;
  fs.rmSync(controlPath);
  const answer = await proxyRequest(proxy.port, ["GET http://127.0.0.1:9/ HTTP/1.1", "Host: 127.0.0.1:9", right]);
  assert.match(answer, /^HTTP\/1.1 502/);
  assert.equal(opened, 0);
  assert.equal(runningSshProxy(proxy.port), undefined);
});

test("ssh -W run for the proxy doesn't start the user's shell with its startup files", (t) => {
  const { sshForward } = require("../dist/ssh/index.js");
  const dir = scratch(t);
  const marker = path.join(dir, "ran");
  fs.writeFileSync(path.join(dir, ".zshenv"), `echo yes > ${marker}\n`);
  const saved = { SHELL: process.env.SHELL, ZDOTDIR: process.env.ZDOTDIR };
  process.env.SHELL = "/bin/zsh";
  process.env.ZDOTDIR = dir;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const stream = sshForward({ controlPath: path.join(dir, "missing"), destination: "localhost" }, "127.0.0.1", 22);
  return new Promise((resolve) => {
    stream.on("close", () => {
      assert.equal(fs.existsSync(marker), false);
      resolve();
    });
    stream.resume();
  });
});

test("a proxy's password goes only to the session routed through it", async (t) => {
  const { sshProxyFor, sshProxyLogin } = require("../dist/web/ssh-proxies.js");
  const controlPath = path.join(scratch(t), "control");
  fs.writeFileSync(controlPath, "");
  const proxy = await sshProxyFor({ controlPath, destination: "login-host" }, direct, 50);
  t.after(() => proxy.close());
  assert.equal(sshProxyLogin(proxy.port, proxy.port), proxy);
  assert.equal(sshProxyLogin(undefined, proxy.port), undefined);
  assert.equal(sshProxyLogin(proxy.port + 1, proxy.port), undefined);
});

test("two ssh connections to the same host get separate browser sessions", () => {
  const { sshPartition } = require("../dist/ssh/index.js");
  const first = sshPartition({ controlPath: "/run/pixel/ssh/t-aaaa/control", destination: "dev@box" });
  const second = sshPartition({ controlPath: "/run/pixel/ssh/t-bbbb/control", destination: "dev@box" });
  assert.notEqual(first, second);
  assert.match(first, /^ssh-dev@box-t-aaaa$/);
});

test("with no ssh connection left, ssh -W fails instead of connecting on its own", (t) => {
  const missing = path.join(scratch(t), "control");
  const result = spawnSync("ssh", ["-F", "/dev/null", "-o", "ProxyCommand=false", "-o", "BatchMode=yes", "-o", "ControlMaster=no", "-S", missing, "-W", "127.0.0.1:22", "--", "localhost"], {
    encoding: "utf8",
    timeout: 10_000,
    input: "",
  });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /SSH-2.0/);
  // Without ProxyCommand=false ssh would dial localhost itself and get as far as its host key or auth.
  assert.doesNotMatch(result.stderr, /Host key verification|Permission denied|Connection refused/);
});

test("a symlinked ~/.ssh/config of ours is followed to its checked real file", (t) => {
  const home = scratch(t);
  fs.mkdirSync(path.join(home, ".ssh"));
  const dotfiles = path.join(home, "dotfiles");
  fs.mkdirSync(dotfiles);
  const real = path.join(dotfiles, "ssh_config");
  fs.writeFileSync(real, "Host x\n", { mode: 0o600 });
  fs.symlinkSync(real, path.join(home, ".ssh", "config"));
  assert.equal(userSshConfig(home), fs.realpathSync(real));
  fs.chmodSync(real, 0o666);
  assert.equal(userSshConfig(home), "/dev/null");
  fs.chmodSync(real, 0o600);
  assert.equal(userSshConfig(home, process.getuid() + 1), "/dev/null");
});

test("IPv6 literal targets work in brackets, and nothing looser does", () => {
  const { parseSshTarget } = require("../dist/ssh/index.js");
  assert.deepEqual(parseSshTarget("[::1]"), { destination: "::1", sshPort: null });
  assert.deepEqual(parseSshTarget("dev@[fe80::1]:2222"), { destination: "dev@fe80::1", sshPort: "2222" });
  for (const target of ["::1", "[::1", "[zz::1]", "[::1]%eth0", "[::1]:0", "[-oProxyCommand=x]", "dev@[::1]x"]) {
    assert.throws(() => validateSshTarget(target), /invalid ssh target/, target);
  }
  assert.deepEqual(parseSshProxyRules(sshProxyRules({ controlPath: "/run/c", destination: "dev@fe80::1" })), {
    controlPath: "/run/c",
    destination: "dev@fe80::1",
  });
  assert.equal(parseSshProxyRules(sshProxyRules({ controlPath: "/run/c", destination: "dev@-oProxyCommand=x" })), null);
});

test("a forwarded host may not carry %", () => {
  assert.throws(() => sshForward({ controlPath: "/run/c", destination: "h" }, "a%hb", 80), /invalid destination/);
});
